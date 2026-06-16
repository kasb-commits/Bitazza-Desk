# AWS Deployment Overview — CS Bot (Bitazza Desk)

**Audience:** Infrastructure / DevOps team
**Purpose:** Describe the three deployable services, what each needs to run on AWS, and how they connect together.
**Project:** AI Customer Support Agent for Freedom Platform & Bitazza Exchange.

> The app currently runs on Railway (backend + dashboard) and Fly.io (widget). Every service already ships with a working `Dockerfile`, so the cleanest AWS path is **container-based** (ECR + ECS/Fargate or App Runner) rather than a rewrite. No AWS-specific infra-as-code exists yet — it needs to be created.

---

## Service Summary

| # | Service | Path | Tech | Runtime model | Suggested AWS target |
|---|---------|------|------|---------------|----------------------|
| 1 | **Backend API** | `/` (root, `api/main.py`) | Python 3.13 / FastAPI / Uvicorn | Long-running container w/ in-process background jobs | ECS Fargate (single service) behind ALB |
| 2 | **Dashboard** | `/dashboard` | React 19 (Vite) SPA + Node/Express server | Container (Node serves SPA + Socket.io + proxy) | ECS Fargate behind ALB |
| 3 | **Chat Widget** | `/frontend/widget` | React 19 (Vite), built as IIFE bundle | Pure static asset (`widget.iife.js`) | S3 + CloudFront |

---

## 1. Backend API (FastAPI)

The core AI engine: chat, copilot, RAG/knowledge base, email channel, ticket workflow, auth.

- **Image:** `Dockerfile` at repo root — base `python:3.13-slim`, installs `build-essential` + `libpq-dev`.
- **Start command:** `uvicorn api.main:app --host 0.0.0.0 --port 8080`
- **Listen port:** `8080`
- **Health check:** `GET /health` → `{"status":"ok"}`
- **Logging:** Set `LOG_FORMAT=json` for structured logs (CloudWatch-friendly).

### Background jobs (run *in-process*, not separate workers)
All schedulers are `asyncio` loops started on app startup — **no separate worker service or cron is needed**, but it means the backend should run as a **single instance** (or jobs will double-fire if scaled horizontally without coordination).

| Job | Interval | Purpose |
|-----|----------|---------|
| Auto-transitions | 15 min | Snooze/close/escalate stale tickets |
| Email safety net | 5 min | Fallback email polling if Pub/Sub fails |
| Report scheduler | Daily 09:00 / weekly Mon (Bangkok) | Send CS reports |
| Notification scanner | 60 sec | SLA warnings, breaches, VIP alerts |
| Gmail watch renewal | On startup | Re-register Gmail Pub/Sub watch (expires every 7d) |
| KB reindex | On startup if empty | Rebuild vector embeddings |

> ⚠️ **Scaling note:** Because jobs run inside the web process, deploy the backend as **1 task / desired count = 1** unless job-level locking is added. The email channel already uses a DB concurrency lock (migration 006), but the other loops do not.

### Data stores & external dependencies
| Dependency | Stateful | AWS mapping | Notes |
|------------|----------|-------------|-------|
| **PostgreSQL** (`DATABASE_URL`) | ✅ | **RDS PostgreSQL** | Must have the **pgvector** extension. Shared with the dashboard Node server. |
| **pgvector** | ✅ (in Postgres) | RDS (enable `vector` extension) | Vector embeddings table; replaces deprecated ChromaDB. |
| **ChromaDB** (`CHROMA_PATH`, default `./data/chroma`) | ✅ (local file) | EFS volume *(or skip — pgvector is preferred)* | Legacy; only needed if pgvector path isn't used. |
| Local uploads (`./uploads`, email attachments) | ✅ | **EFS** mount, or migrate to **S3** | Currently writes to local disk; needs persistent volume or S3 refactor. |
| **Gemini API** (`GEMINI_API_KEY`) | ❌ | External (Google) | LLM + embeddings. Egress to Google required. |
| **Gmail API + Google Pub/Sub** | ❌ | External (Google) | Email ingestion via push webhook; needs public `API_BASE_URL`. |
| Freshdesk / Yellow.ai | ❌ | External | **Scripts/export only — not runtime.** |
| Bitazza Exchange API (optional) | ❌ | External | Real auth+KYC; off by default (`USE_EXCHANGE_API=false`). |

### Database migrations
- SQL migrations live in `db/migrations/` (017 files).
- **pgvector migration (015)** is applied automatically by the backend on startup.
- **All other schema** is applied by the **dashboard's Node server** (`node src/db/migrate.js`) on its startup — the backend's `init_db()` is a no-op.
- Net effect: bring up the dashboard service (or run its migrate step) so the schema exists; no manual migration step otherwise.

### Key environment variables (full list in `config/settings.py` / `.env.example`)
**Required:** `GEMINI_API_KEY`, `DATABASE_URL`, `JWT_SECRET`, `FRESHDESK_API_KEY`, `FRESHDESK_SUBDOMAIN`
**Important runtime:**
- `MODEL` (default `gemini-2.5-flash`), `ENV=production`, `LOG_FORMAT=json`
- `ALLOWED_ORIGINS` — **CORS allowlist; must include the dashboard URL and any widget host origin**
- `API_BASE_URL` — public URL of the backend (used for Gmail Pub/Sub webhook target)
- Email: `GMAIL_CREDENTIALS_JSON`, `GOOGLE_PUBSUB_TOPIC`, `GMAIL_PUBSUB_SECRET`, `GMAIL_SUPPORT_EMAIL`
- Widget auth (optional): `USE_EXCHANGE_API`, `EXCHANGE_BE_BASE_URL`, `WIDGET_HMAC_SECRET`, `WIDGET_CLIENT_ID`
- Feature flags: `USE_MOCK_USER_API` (default `true`), `USE_MOCK_EMAIL_VERIFY` (default `true`)

> Put all secrets in **AWS Secrets Manager / SSM Parameter Store** and inject as env vars. Never bake into the image.

---

## 2. Dashboard (CS Agent UI)

Internal app for support agents/supervisors: inbox, ticket management, copilot, AI Studio, analytics.

- **Image:** `dashboard/Dockerfile` — multi-stage: `node:20-alpine` builds the Vite SPA (`vite build` → `dist/`), then a Node/Express server serves the static bundle **and** runs application logic.
- **Start command:** `node server/src/index.js` (Railway variant: `node src/db/migrate.js && node src/index.js`)
- **Listen port:** `3002`
- **Health check:** `GET /health` → `{ok:true}`

> ⚠️ The dashboard is **not** a pure static SPA. The bundled Node server (a) serves the React build, (b) runs **Socket.io** for real-time updates, (c) proxies/serves `/api` routes, and (d) **runs the PostgreSQL schema migrations** (`migrate.js`). It therefore needs a runtime container (App Runner / Fargate) — not S3/CloudFront.

### Build-time variables (baked into the SPA bundle — set as Docker build ARGs)
- `VITE_API_URL` — backend API base URL
- `VITE_SERVER_URL` — Socket.io / dashboard server URL

### Runtime variables (Node server — see `dashboard/server/.env.example`)
- `DATABASE_URL` — **same RDS PostgreSQL as the backend**
- `REDIS_URL` — **requires ElastiCache (Redis)** for sessions/queues
- `JWT_SECRET` — must match the backend's JWT secret for shared auth
- `GEMINI_API_KEY` — AI features in the dashboard
- `CORE_API_URL`, `CORE_API_KEY` — read-only Bitazza core API
- `FRONTEND_URL` — CORS origin
- `SERVER_PORT=3002`

### Auth
JWT-based. `POST /api/auth/login` returns a token stored in `localStorage`; sent as `Authorization: Bearer <token>` on every request. 401 clears the session.

---

## 3. Chat Widget (Embeddable)

The customer-facing chat bubble embedded on Bitazza/Freedom web properties.

- **Build:** Vite → single **IIFE bundle** `dist/widget.iife.js` (global `CSBot`). Self-contained, no dependencies at runtime.
- **Runtime model:** **Pure static.** No server needed. Host via **S3 + CloudFront**.
- **Existing `Dockerfile`** builds the bundle and serves it via `nginx:alpine` on port 80 — usable if you prefer a container, but S3+CloudFront is simpler/cheaper.
- **Build-time variable:** `VITE_API_URL` (baked in; default `http://localhost:8000`, prod currently `https://csbot-api-production.up.railway.app`).
- **No WebSocket** — HTTP fetch only. State in `localStorage`.

### Embed model
Host pages set config then load the script:
```html
<script>
  window.CSBotConfig = {
    platform: 'bitazza',
    apiUrl: 'https://<backend-api-domain>',
    token: '<JWT_SIGNED_BY_HOST>',   // optional; for authenticated sessions
    primaryColor: '#00CE80',
  };
</script>
<script src="https://<cloudfront-domain>/widget.iife.js"></script>
```
The widget mounts itself (`div#csbot-root`) and calls the backend directly using `apiUrl`.

> CloudFront caching: `widget.iife.js` should be served with a short/validated cache or content-hashed filenames so embed sites pick up new builds.

---

## How the Three Services Connect

```
                          Customer's website / Bitazza web app
                          ┌──────────────────────────────────┐
                          │   <script> widget.iife.js         │
                          │   window.CSBotConfig.apiUrl ──────┼──┐
                          └──────────────────────────────────┘  │
                                                                 │ HTTPS (REST)
   S3 + CloudFront ──serves──> widget.iife.js                    │ /chat/*, /widget/session/init
   (Service 3, static)                                           ▼
                                                    ┌────────────────────────────┐
   CS Agents' browser                               │   Backend API (FastAPI)    │
   ┌───────────────────────┐                        │   Service 1 — :8080        │
   │ Dashboard SPA (React)  │                        │   chat, copilot, RAG,      │
   │ loaded from Node srv   │                        │   email, auth, tickets     │
   └───────────┬───────────┘                        │   + in-process schedulers  │
               │ HTTPS REST + Socket.io (WSS)        └──────┬──────────┬──────────┘
               ▼                                            │          │
   ┌───────────────────────────┐                           │          │ Gemini API
   │ Dashboard Node/Express     │  shares DATABASE_URL      │          │ Gmail + Pub/Sub
   │ Service 2 — :3002          │◀─────────────────────────┐│          │ (Google, external)
   │ serves SPA, Socket.io,     │                          ││          ▼
   │ /api proxy, runs migrate.js│                          ││   (egress to internet)
   └───────────┬───────────────┘                          ││
               │                                           ▼▼
               │                          ┌───────────────────────────────┐
               └─────────────────────────▶│  RDS PostgreSQL (+ pgvector)  │◀── shared by S1 & S2
                                          └───────────────────────────────┘
   Dashboard Node also uses ──▶ ElastiCache (Redis)   [sessions / queues]
```

### Connection details

1. **Widget → Backend (Service 3 → Service 1):** Direct HTTPS REST. The widget reads `apiUrl` from `window.CSBotConfig` (or build-time `VITE_API_URL`) and calls endpoints like `/chat/start`, `/chat/send`, `/widget/session/init`. The backend's `ALLOWED_ORIGINS` **must include the widget's host origins**.

2. **Dashboard SPA → Dashboard Node server (within Service 2):** The React app calls `VITE_API_URL` for REST and `VITE_SERVER_URL` for **Socket.io (WSS)** real-time ticket/notification updates. The ALB/target group fronting the dashboard must allow WebSocket upgrades.

3. **Dashboard → Backend (Service 2 → Service 1):** The dashboard Node server proxies/forwards `/api` traffic to the FastAPI backend for AI/chat/copilot operations.

4. **Shared PostgreSQL (Service 1 + Service 2 → RDS):** Both connect to the **same `DATABASE_URL`**. The dashboard Node server owns schema migrations (`migrate.js`); the backend applies only the pgvector migration. The DB must have the **pgvector extension** enabled.

5. **Shared JWT secret:** Backend and dashboard must use the **same `JWT_SECRET`** so tokens issued by one are accepted by the other.

6. **Dashboard → Redis (Service 2 → ElastiCache):** The Node server requires `REDIS_URL` for sessions/queues — **provision ElastiCache**.

7. **Backend → External (Google):** Gemini (LLM + embeddings) and Gmail/Pub/Sub for the email channel. Pub/Sub pushes to the backend's public `API_BASE_URL/email/webhook`, so the backend must be reachable from the internet (via ALB/public endpoint).

---

## Suggested AWS Topology (starting point)

| Component | AWS service | Notes |
|-----------|-------------|-------|
| Backend API | **ECS Fargate** (1 task) behind **ALB** | Single instance due to in-process schedulers. Public for Pub/Sub webhook. |
| Dashboard | **ECS Fargate** behind **ALB** | Enable WebSocket on target group for Socket.io. |
| Widget | **S3 + CloudFront** | Static `widget.iife.js`. |
| Database | **RDS PostgreSQL** (pgvector enabled) | Shared by backend + dashboard. |
| Cache | **ElastiCache (Redis)** | Required by dashboard Node server. |
| Persistent files | **EFS** (mount on backend) or refactor to **S3** | For `./uploads`, email attachments, optional ChromaDB. |
| Images | **ECR** | One repo per service (backend, dashboard). |
| Secrets | **Secrets Manager / SSM** | All API keys, DB URLs, JWT secret. |
| Logs/metrics | **CloudWatch** | Backend already emits JSON logs (`LOG_FORMAT=json`). |

### Open items to confirm before deploy
- **Single-instance backend** vs. adding job-locking if horizontal scaling is required.
- **Uploads storage**: EFS mount vs. refactor `./uploads` to S3 (current code writes local disk).
- **ChromaDB vs pgvector**: confirm pgvector is the live vector path so ChromaDB/EFS can be skipped.
- **Public endpoints**: backend must be internet-reachable for Gmail Pub/Sub push.
- **Domains/TLS**: ACM certs + Route 53 records for backend, dashboard, and the CloudFront widget distribution.
- **CORS**: finalize `ALLOWED_ORIGINS` (dashboard URL + every site embedding the widget).
```
