# CS BOT — Claude Code Guide

## Project
AI Customer Support Agent for Freedom Platform & Bitazza Exchange.
Stack: Python/FastAPI backend · React frontend · Gemini Flash (LLM) · ChromaDB (vector) · PostgreSQL (state).

## Key Directories
```
scripts/       Phase 0: Freshdesk/YellowAI export + classification + analysis
ingestion/     Knowledge base pipeline (tickets, blogs, docs → vector DB)
engine/        AI core: agent, RAG retriever, account tools, escalation, filters, email parser
api/           FastAPI app (chat, copilot, email, knowledge, dashboard, auth routes + middleware)
db/            Vector store + conversation store + email store abstractions + migrations/
dashboard/     CS agent dashboard React app (HomeDashboard, SupervisorDashboard, CopilotPanel, AIStudio, ...)
frontend/      Embeddable chat widget React app (Widget, ChatWindow, CategoryPicker, PrevConversations)
config/        Settings (env-based, never hardcoded secrets)
tests/         Pytest test suite
```

## Critical Rules

### Correctness
- Read a file before editing it
- If a file was edited earlier in this session, re-read it before making further edits
- Before changing a function signature, grep all callers first
- Change only what was asked — unless the surrounding code makes the requested change incorrect or unsafe
- Never alter existing `db/migrations/` files — only add new ones
- After changes to `engine/` or `api/routes/`, grep for a corresponding test and note whether it covers the change

### Project-Specific Invariants
- Secrets live in `.env` only — never hardcode API keys
- All LLM calls use the model set in `config/settings.py` (`MODEL`) which reads from the `MODEL` env var — never hardcode a model string
- RAG always cites source chunk metadata in responses
- Escalation threshold: confidence < 0.6 OR explicit trigger keywords
- Language: auto-detect EN/TH on every message; use matching prompt template
- Account tools (KYC, deposits, etc.) require authenticated user_id from JWT — never trust client-supplied IDs
- `security_filter` runs BEFORE generation, `compliance_filter` AFTER — this order must never change
- If an EN prompt template changes, the TH template must be updated to match semantically
- `engine/account_tools.py` functions are intentionally stubbed (fake data) — never replace with real calls without explicit instruction
- Email processing claim logic (migration 006) is a concurrency lock — never simplify or bypass without explicit instruction
- `tests/conftest.py` has session-scoped DB fixtures shared across all tests — changes here can silently break the entire suite

### Memory
- Any session that creates, edits, or deletes files must update affected memory files and refresh their `last_verified` date before closing
- Before acting on a memory claim that references a file, function, or implementation status, verify it against current code first if `last_verified` is more than 7 days old

### Token Efficiency
- Grep for a symbol before opening a file — use `files_with_matches` first, then read only matching files
- Never read `dashboard/node_modules/` or `frontend/widget/node_modules/`
- When fixing a bug in `engine/` or `api/`, grep test files to check for encoded business rules before editing — don't read them speculatively

## Env Vars (see .env.example)
`GEMINI_API_KEY` · `FRESHDESK_API_KEY` · `FRESHDESK_SUBDOMAIN` · `YELLOWAI_API_KEY` · `DATABASE_URL` · `CHROMA_PATH` · `JWT_SECRET` · `MODEL`

## Changing the Gemini Model
When switching models, update ALL of the following — missing any one will cause silent failures:

| What | Location | Notes |
|------|----------|-------|
| Railway env var | `MODEL` in Railway → csbot-api service | Primary control — do this first |
| Fallback default | `config/settings.py` line 9 | Update the hardcoded fallback string |
| classify_tickets script | `scripts/classify_tickets.py` line 18 | Local/one-off only, not production |
| reclassify script | `scripts/reclassify_ai_handling.py` line 28 | Local/one-off only, not production |
| Embedding model | `db/vector_store.py` line 23 `_EMBED_MODEL` | Separate from chat model — versioned independently |

Files already reading from `config.settings.MODEL` correctly (no change needed): `engine/agent.py`, `engine/mock_agents.py`, `api/copilot.py`

## Commands
```bash
pip install -r requirements.txt          # install deps
python scripts/freshdesk_export.py       # export Freshdesk tickets
python scripts/yellowai_export.py        # export Yellow.ai tickets
python scripts/classify_tickets.py       # classify tickets with Gemini Flash
python scripts/analyze_categories.py     # rank use cases by volume
uvicorn api.main:app --reload            # run API server
```

## Phase Status
- [x] Phase 0: Ticket classification (Freshdesk + Yellow.ai)
- [x] Phase 1 backend: AI engine built (agent, RAG, account tools, security, escalation, API)
- [x] Phase 1 frontend: React chat widget (Widget, ChatWindow, CategoryPicker, PrevConversations) + Playwright e2e
- [x] Phase 1 dashboard: CS agent dashboard UI (HomeDashboard, SupervisorDashboard, ConversationList, CopilotPanel, AIStudio, AnalyticsDashboard, and more)
- [x] Email channel: Gmail ingestion, email parser, email store, processing claims (migrations 004–006)
- [ ] Phase 2: Agent productivity features
  - [ ] **Call feature**: initiate outbound calls to a customer's phone number directly from the Inbox or User 360 view (click-to-call; requires telephony integration — e.g. Twilio/Vonage; log call outcome back to ticket)
  - [ ] **Ticket share deeplink**: generate a shareable URL for any ticket that renders full conversation history + current ticket status when opened; works across channels (Slack, email, Line, etc.); anyone with the link can read messages and status (no login required); logged-in agents additionally see internal notes and sensitive account data
  - [ ] **Widget reply recommendations**: AI reads the full conversation history (prior customer messages + AI/agent replies) and surfaces 2–3 suggested next replies inline in the chat widget; customer can tap a suggestion to pre-fill the input box; suggestions are regenerated after every new message from either side; works during both bot and human-agent sessions; suggestions must respect the detected language (EN/TH); implemented in `frontend/widget/` as a `SuggestedReplies` component calling a new `/api/chat/suggest` endpoint backed by `engine/agent.py`
  - [ ] **Temporary KB (TempKB)**: a short-lived, auto-expiring knowledge layer separate from the permanent ChromaDB KB; purpose is to capture transient operational issues (app bugs, maintenance windows, downtime notices) so the bot can answer related inquiries without polluting the permanent KB with stale data; design constraints:
    - Stored in a dedicated ChromaDB collection (`temp_kb`) distinct from `knowledge_base`
    - A background scheduler (APScheduler or similar) runs every 24 hours: queries recently-escalated tickets from PostgreSQL, extracts recurring themes via LLM, and upserts summaries into `temp_kb` with a TTL timestamp
    - A second scheduler pass (configurable interval, default 48 h) hard-deletes all chunks whose TTL has elapsed
    - RAG retriever checks `temp_kb` first; if a matching chunk is found, it is prepended to context with a `[TEMP]` tag so the agent knows the info may be short-lived
    - No manual curation required — fully automatic ingestion and expiry
    - New env vars: `TEMP_KB_INGEST_INTERVAL_HOURS` (default 24) · `TEMP_KB_TTL_HOURS` (default 48)
    - New files: `engine/temp_kb_manager.py` (ingest + expiry logic) · `db/temp_kb_store.py` (ChromaDB wrapper for `temp_kb` collection) · `api/routes/temp_kb.py` (admin endpoints: force-refresh, list active chunks, manual delete)
  - [ ] **KYC details in User 360**: surface customer identity data inside the dashboard's User 360 view; two-tier design to balance load speed with data sensitivity:
    - **Tier 1 — basic summary (auto-loaded)**: name, nationality, KYC status (pending/approved/rejected), verification level, and submission date are fetched automatically when an agent opens User 360 and displayed in a dedicated "KYC" card; data comes from the existing account tools layer (`engine/account_tools.py`) via a new `/api/account/kyc/summary/{user_id}` endpoint; requires agent JWT — user_id is always resolved server-side from the ticket, never trusted from the client
    - **Tier 2 — full KYC pull (agent-triggered)**: a "View Full KYC" button in the KYC card triggers a separate authenticated call to `/api/account/kyc/full/{user_id}`; returns sensitive fields — residential address, ID/passport image URLs, selfie image URL, date of birth, tax ID, and any rejection notes; images are returned as short-lived pre-signed URLs (expire in 15 min) rather than proxied blobs; the button is visible only to agents with the `kyc_viewer` role; every full-pull is written to an audit log (agent_id, user_id, timestamp) in PostgreSQL
    - Both endpoints are stubs in `engine/account_tools.py` (consistent with existing stub pattern) — never replace with real external calls without explicit instruction
    - Frontend: extend `dashboard/src/components/User360.jsx` (or equivalent) with a `KYCCard` sub-component; full KYC panel opens in a modal with image previews and field list; no KYC data is ever written to localStorage or the browser URL
    - New migration (`db/migrations/007_kyc_audit_log.sql`) to create the `kyc_audit_log` table

## Data (Phase 0 results — 3,438 tickets)
Top categories: kyc_verification 21% · account_restriction 19% · password_2fa_reset 10% · fraud_security 7% · withdrawal_issue 7%
68% Thai · 30% English · 76% account-specific → live account API integration mandatory
