# Security Checklist

Findings from internal audit — 2026-05-14.
Fix in priority order.

---

## CRITICAL

### 1. Privilege Escalation — No RBAC on Agent/Role Management
**File:** `api/routes/dashboard.py:459–572`

All agent and role management endpoints only verify JWT presence (`Depends(get_user_id)`).
Any authenticated agent, regardless of role, can:
- Create a new agent with `role: "super_admin"` → instant privilege escalation
- Reset any agent's password
- Deactivate / reactivate any agent
- Modify any agent's role
- Create, update, or delete roles and their permissions

**Fix:** Add a role guard dependency (e.g. `require_role("admin")`) to every admin-level endpoint. The `ROLE_PERMISSIONS` map already exists in `api/routes/auth.py` — enforce it server-side.

Affected endpoints:
- `POST /agents`
- `PATCH /agents/{agent_id}`
- `DELETE /agents/{agent_id}`
- `POST /agents/{agent_id}/reactivate`
- `POST /agents/{agent_id}/reset-password`
- `POST /roles`, `PATCH /roles/{name}`, `DELETE /roles/{name}`

---

### 2. Unauthenticated Studio Test-Run Endpoint
**File:** `api/routes/studio.py:19`

`POST /studio/test-run` has zero authentication. Anyone on the internet can execute workflows with an arbitrary `user_id`. Exceptions are also leaked in plain-text responses (`"error": str(exc)`).

**Fix:**
- Add `user_id: str = Depends(get_user_id)` to `studio_test_run()`
- Replace `str(exc)` in the except block with a generic message; log the real error server-side only

---

## HIGH

### 3. Unauthenticated Dashboard WebSocket — Arbitrary Event Injection
**File:** `api/routes/dashboard.py:1027`

`/ws/conversations` accepts unauthenticated connections and broadcasts client-supplied `agent_id` and `agent_name` fields as `agent_presence`/`agent_typing` events to all connected dashboards.

**Fix:** Require a JWT query param (`?token=...`) on connect and verify it with `get_user_id` before accepting the connection. Ignore or override client-supplied `agent_id` — derive it from the verified token.

---

### 4. Unauthenticated Gmail Pub/Sub Webhook
**File:** `api/routes/email.py:847`

`POST /email/webhook` performs no OIDC token verification. Anyone who knows the URL can POST a fake `historyId` and trigger Gmail API calls or log pollution.

**Fix:** Verify the `Authorization: Bearer <token>` OIDC header Google sends with every push notification. Use `google-auth` library's `id_token.verify_oauth2_token()`. Reject requests with missing or invalid tokens with HTTP 401.

---

### 5. Dev Auth Bypass Active Outside `"production"` ENV
**File:** `api/middleware/auth.py:17–19`

When `ENV` is unset or any value except `"production"`, all unauthenticated requests succeed as `"dev_user"`. A misconfigured staging deployment silently opens every endpoint to the public.

**Fix:** Change the fallback to a second explicit allowlist: only bypass auth when `ENV == "development"` AND `DEBUG == "true"`. Log a loud warning on startup when dev bypass is active. Block bypass in any environment named `staging` or `production`.

---

### 6. File Upload — No Size Cap, Spoofable MIME, Path Traversal via Filename
**File:** `api/routes/dashboard.py:510–525`

Three issues in `upload_agent_avatar`:
- **No size limit** — `shutil.copyfileobj` reads unlimited bytes; disk exhaustion DoS is trivial
- **MIME type is client-controlled** — FastAPI passes the multipart `Content-Type` as-is; a client sends `Content-Type: image/jpeg` while uploading a `.html` file, bypassing the allowlist check
- **Path traversal via filename** — `Path(avatar.filename).suffix` on a filename like `../../shell.sh` yields `.sh` and the write path may escape `UPLOADS_DIR`

**Fix:**
- Cap reads: pass `length=5 * 1024 * 1024` (5 MB) to `shutil.copyfileobj` or read in chunks
- Validate MIME by reading file magic bytes (e.g. `python-magic`) instead of trusting the header
- Sanitise the extension allowlist to `{".jpg", ".jpeg", ".png", ".gif", ".webp"}` and construct the destination filename entirely server-side (never from `avatar.filename`)

---

### 7. Widget WebSocket — Unauthenticated Conversation Stream Subscription
**File:** `api/routes/chat.py:336`

`/ws/{conversation_id}` allows any unauthenticated client to subscribe to a conversation's real-time stream. Guessing or enumerating a UUID is enough to eavesdrop on live agent/customer messages.

**Fix:** Require a short-lived signed token (issued at conversation start, embedded in the widget) as a query param. Verify it on WebSocket connect before adding the socket to the room.

---

## Checklist

- [ ] **CRITICAL-1** Add `require_role("admin")` guard to all agent/role management routes
- [ ] **CRITICAL-2** Add `Depends(get_user_id)` to `/studio/test-run`; scrub exception details from response
- [ ] **HIGH-3** JWT verification on `/ws/conversations` WebSocket connect
- [ ] **HIGH-4** OIDC token verification on `/email/webhook`
- [ ] **HIGH-5** Tighten dev-auth bypass condition; add startup warning
- [ ] **HIGH-6** File upload: size cap + magic-byte MIME check + server-side filename construction
- [ ] **HIGH-7** Signed token required on widget WebSocket connect
