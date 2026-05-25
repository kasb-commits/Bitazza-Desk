# Changelog

All delivered changes to Bitazza-Desk, newest first.

---

## [2026-05-25] Intent Classification + KYC Workflow Loop Fix + Response Truncation Fix

### Intent Classifier
- `engine/agent.py` — new `_classify_intent()` function: dedicated lightweight Gemini call (`CLASSIFIER_MODEL`) before the main generation that classifies each message as `informational` or `account_specific`; informational questions have tools stripped so the model answers from KB context only and cannot trigger account tool calls or the collection phase
- `engine/agent.py` — step 3c added to `chat()`: classifier runs for all account categories on authenticated sessions; on classifier failure defaults to `account_specific` (safe over-fetch)
- `engine/agent.py` — short follow-up query expansion: messages under 8 words are prepended with the previous user turn before RAG retrieval to prevent word-hash fallback from returning wrong chunks
- `config/settings.py` — `CLASSIFIER_MODEL` env var added (default `gemini-2.5-flash-lite`); `MAX_TOKENS` now env-overridable (default raised from 1024 → 2048 to accommodate `gemini-2.5-flash` thinking token overhead)

### Prompt Improvements
- `engine/prompt_templates.py` — rule 5 (EN + TH base prompts) rewritten: model now applies a reasoning test ("could I answer this the same way for any user?") to classify intent instead of pattern-matching on surface words; informational questions answered from conversation context; account-specific questions use tools or escalate
- `engine/prompt_templates.py` — new global rule (EN + TH base prompts): when listing requirements, steps, or items of any kind, list every item completely; process/system notes must not replace actual requirement items; tier/level listings are cumulative
- `engine/prompt_templates.py` — KYC overlay (EN + TH): removed now-redundant KYC-specific versions of both rules (covered by base prompt)

### KYC Workflow Bug Fix
- DB patch to KYC Verification workflow: approved branch (`n3`) previously went directly to `resolve_ticket` (`n4`) with no follow-up handling, causing every subsequent message to restart a new execution and replay the same approved message. Added `wait_for_reply → ai_reply → condition(escalated?) → escalate/condition(resolved?) → resolve_ticket/wait_for_reply_loop` after the approved message node, matching the pattern used by all other branches

---

## [2026-05-20] File Attachments + Agent Improvements + Dashboard UI Polish

**Commits:** `f582bd4`, `f191b47`

### File Attachments
- `api/routes/uploads.py` — new `POST /api/uploads/attachment` endpoint; stores files to `uploads/attachments/` with UUID prefix
- `api/main.py` — registers uploads router at `/api/uploads`
- `api/routes/chat.py` — `attachment_ids` field in `MessageRequest`; `_resolve_attachments` helper maps UUIDs to metadata; bot escalates immediately when attachment is received (AI never reads files); info-collection phase support: escalates if user declines screenshot during fraud/restriction flow
- `frontend/widget/src/ChatWindow.tsx` — attachment upload UI (file picker, preview strip, sends attachment_ids with message)
- `frontend/widget/src/MessageBubble.tsx` — renders attachment thumbnails/links in chat bubbles
- `frontend/widget/src/api.ts` + `types.ts` — attachment upload API call; `attachment_ids` in `SendMessageRequest`
- `db/conversation_store.py` — `get_info_collection_phase`, `set_info_collection_phase`, `count_collection_turns`

### Agent Improvements
- `engine/agent.py` — `suppress_handoff` param prevents double-escalation when `ai_reply` workflow node calls `chat()` internally; `no_active_workflow` escalation guard: account-specific categories (`kyc_verification`, `account_restriction`, etc.) escalate to human when no published workflow exists for that category
- `engine/prompt_templates.py` — `GUEST_PREAMBLE` added (clarify before responding, login nudge only for account queries, conciseness cap); base EN prompt gains conciseness + no-repeat rules

### Dashboard UI
- `ConversationList`, `MessageThread`, `SupervisorDashboard`, `User360`, `AdminSettings`, `HomeDashboard`, `CopilotPanel`, `PropertiesPanel` — UI polish pass across all major dashboard views
- `ui/Badge`, `ui/KpiCard`, `ui/Select` components updated; `index.css` additions
- Node server: `tickets.js` includes `kyc_tier`; `roles.js` fix; `migrate.js` updates

### Test Suite Fixes (34 failures resolved)
- Workflow unit tests: `suppress_handoff`, `get_ticket_meta`, `create_verification_token` mocks added
- Execution engine tests: fixed execution capture pattern and `run_node` call_args scope
- Category upgrade test: corrected assertion — `detect_upgrade` lives in router, not engine
- Regression tests: added missing `get_ticket_meta`/`get_ai_persona` mocks; fixed escalation phrase values
- Integration tests: aligned `conversation_id == ticket_id` invariant; fixed `WorkflowExecutionEngine` patch path
- E2E studio tests: rewrote to use `/studio/test-run` with correct `TestRunRequest` body format
- `engine/auto_transitions.py`: fail-open `try/except` around `is_workflow_active` guard; `pending_customer_expired` now routes email→`Resolved`, widget→`snoozed`

---

## [2026-05-19] KYC Tier — Full Stack

**Commit:** `a2af4fa`

Added KYC tier (0=Unverified, 1=Basic, 2=Enhanced, 3=Full/Professional) across the entire stack.

**Mock API**
- `engine/mock_api/models.py` — `KYCInfo` model gains `kyc_tier: int = 0`
- `engine/mock_api/users.py` — all approved mock users assigned tiers (USR-000001→T1, USR-000002/003/023/024→T2, USR-000004/025→T3)

**Database**
- `db/migrations/` — `kyc_tier INT DEFAULT 0` column added to `customers` table (migration run via `migrate.js`)
- `db/conversation_store.py` — `kyc_tier` extracted from `profile["kyc"]["kyc_tier"]` and written in all 4 customer write paths (`_ensure_customer` existing/legacy/new branches + `update_customer_from_profile`); ticket-listing SELECT and result mapping also updated

**Node API**
- `dashboard/server/src/routes/tickets.js` — `c.kyc_tier AS customer_kyc_tier` in both list and single-ticket SELECTs; `kyc_tier` in both customer response mappings
- `dashboard/server/src/routes/users.js` — `kyc_tier` added to customer list SELECT

**Dashboard Frontend**
- `dashboard/src/types.ts` — `CustomerProfile.kyc_tier?: number`
- `dashboard/src/components/PropertiesPanel.tsx` — "KYC Tier" row in the Customer section of the right panel
- `dashboard/src/components/User360.tsx` — `KYC_TIER_COLORS` + `KYC_TIER_LABELS` maps; "KYC Tier" column in the customer list table; KYC tier badge in the user header; "KYC Tier" row inside the KYC Details card

---

## [2026-05-19] Agent Max Chats Ceiling

**Commit:** `25c87c9`

Raised agent `max_chats` ceiling to 100; default changed to 10.

---

## [2026-05-14] Assignment Client Module

**Commit:** `b7992c2`

Fixed missing `assignment_client` module that caused Railway boot crash.

---

## [2026-05-14] Guest (Unauthenticated) Widget Support

**Commits:** `57de5c0` → `ddbe2a3` → `b7992c2`

Full freeform guest chat flow for unauthenticated users.

**Flow**
- Widget detects guest mode via `?guest=1` URL param (`cfg.guestMode`)
- Greeting message + language chips shown first; name/email form appears after language selection
- On form submit (or skip), `startConversation` is called and Ploy sends an intro message before input is unlocked (`awaitingFirstReply` gate)
- No category picker for guests — free-form input routed through `other` category directly to Ploy

**Backend**
- `engine/agent.py` — guest escalation guard: `low_confidence` alone does not escalate guest sessions; keywords, consecutive failures, AI failures, and model `needs_human=true` still escalate normally
- `engine/prompt_templates.py` — `GUEST_PREAMBLE` added: clarify-before-responding rule, login nudge only for genuinely account-specific queries, 3–4 sentence conciseness cap, no paraphrasing rule; base EN system prompt also gains conciseness + no-repeat rules
- `workflow_engine/interceptor.py` — guest sessions skip Gemini category classification (`and user_id is not None` guard)
- `db/conversation_store.py` — guest ticket creation path; guest customer row written with name/email or placeholder
- `engine/assignment_client.py` — new module for async/sync auto-assign HTTP calls to dashboard internal API (was untracked; committed in `b7992c2` to fix Railway boot crash)

**Frontend**
- `frontend/widget/src/ChatWindow.tsx` — dual-mode logic: guest path defers `startConversation` until after form, hides category picker, disables input until Ploy intro arrives
- `frontend/widget/src/GuestIdentityForm.tsx` — redesigned as a chat bubble matching the widget's premium design language (primaryColor ring focus, gradient CTA, skip ghost button)

**Tests**
- `frontend/widget/e2e/widget-guest.spec.ts` — 21 Playwright E2E tests covering full guest flow (opening, form submit/skip, chat, returning guest, authenticated user unaffected)
- `tests/test_guest_widget.py` — 39 pytest unit tests for backend guest widget behaviour
