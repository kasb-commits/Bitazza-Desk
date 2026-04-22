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

## Data (Phase 0 results — 3,438 tickets)
Top categories: kyc_verification 21% · account_restriction 19% · password_2fa_reset 10% · fraud_security 7% · withdrawal_issue 7%
68% Thai · 30% English · 76% account-specific → live account API integration mandatory
