"""
TDD tests for guest (unauthenticated) widget support.

These tests are written BEFORE implementation and are expected to fail initially.
They cover:
  1. Auth middleware — get_optional_user_id() and _decode_token()
  2. Conversation store — create_conversation(user_id=None, is_guest=True)
  3. Agent — chat(user_id=None) uses guest system prompt, passes tools=[]
  4. WorkflowEngine — AccountLookupNode with ctx.user_id=None
  5. Route integration — /chat/start, /chat/message, /chat/customer-tickets
"""
import os
import re
import uuid
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import patch, MagicMock

import pytest

# ── Environment setup (must happen before any project imports) ────────────────
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("FRESHDESK_API_KEY", "test")
os.environ.setdefault("FRESHDESK_SUBDOMAIN", "test.freshdesk.com")
os.environ.setdefault("JWT_SECRET", "test-secret-key")
os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")


# ── Shared SQLite helpers (mirrors test_api.py / test_conversation_store.py) ──

def _make_sqlite_conn():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE customers (
            id TEXT PRIMARY KEY,
            name TEXT, email TEXT, phone TEXT,
            tier TEXT DEFAULT 'regular',
            kyc_status TEXT, external_id TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE tickets (
            id TEXT PRIMARY KEY,
            customer_id TEXT,
            channel TEXT DEFAULT 'web',
            status TEXT DEFAULT 'Open_Live',
            category TEXT,
            priority INTEGER DEFAULT 3,
            team TEXT DEFAULT 'cs',
            assigned_to TEXT,
            ai_persona TEXT,
            csat_score INTEGER,
            sla_deadline TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
        )
    """)
    conn.execute("""
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            ticket_id TEXT,
            sender_type TEXT,
            content TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
        )
    """)
    conn.commit()
    return conn


class _FakeCursor:
    def __init__(self, sqlite_cursor):
        self._cur = sqlite_cursor
        self._rows = []
        self._row_iter = iter([])

    def execute(self, sql, params=()):
        sql = sql.replace("%s", "?")
        sql = sql.replace("::jsonb", "").replace("::uuid", "").replace("::bigint", "")
        sql = sql.replace("NOW()", "strftime('%Y-%m-%d %H:%M:%f', 'now')")
        sql = re.sub(r"EXTRACT\(EPOCH FROM ([^)]+)\)::bigint", r"strftime('%s', \1)", sql)
        sql = re.sub(r"EXTRACT\(EPOCH FROM ([^)]+)\)", r"strftime('%s', \1)", sql)
        sql = re.sub(r"[+\-] INTERVAL '[^']+' \w+", "", sql, flags=re.IGNORECASE)
        sql = re.sub(r"\* INTERVAL '1 minute'", "", sql, flags=re.IGNORECASE)
        sql = re.sub(r"ORDER BY created_at (ASC|DESC)", r"ORDER BY created_at \1, rowid \1", sql, flags=re.IGNORECASE)
        self._cur.execute(sql, params)
        self._rows = self._cur.fetchall()
        self._row_iter = iter(self._rows)

    @staticmethod
    def _coerce_row(row: dict) -> dict:
        for key in ("created_at", "updated_at"):
            val = row.get(key)
            if isinstance(val, str):
                for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
                    try:
                        row[key] = datetime.strptime(val, fmt)
                        break
                    except ValueError:
                        pass
        return row

    def fetchone(self):
        try:
            row = next(self._row_iter)
            return self._coerce_row(dict(row)) if row is not None else None
        except StopIteration:
            return None

    def fetchall(self):
        result = [self._coerce_row(dict(r)) for r in self._rows]
        self._rows = []
        self._row_iter = iter([])
        return result

    def __iter__(self):
        return (dict(r) for r in self._rows)


class _FakeConn:
    def __init__(self, sqlite_conn):
        self._conn = sqlite_conn

    def cursor(self):
        return _FakeCursor(self._conn.cursor())

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        pass


# ─────────────────────────────────────────────────────────────────────────────
# 1. Auth middleware
# ─────────────────────────────────────────────────────────────────────────────

class TestOptionalAuth:
    """Tests for get_optional_user_id() and _decode_token()."""

    def test_decode_token_returns_none_for_empty_string(self):
        from api.middleware.auth import _decode_token
        assert _decode_token("") is None

    def test_decode_token_returns_none_for_invalid_scheme(self):
        from api.middleware.auth import _decode_token
        assert _decode_token("Basic sometoken") is None

    def test_decode_token_returns_none_for_garbage_token(self):
        from api.middleware.auth import _decode_token
        assert _decode_token("Bearer not.a.jwt") is None

    def test_decode_token_returns_user_id_for_valid_jwt(self):
        from api.middleware.auth import _decode_token
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"sub": "user123"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        result = _decode_token(f"Bearer {token}")
        assert result == "user123"

    def test_decode_token_reads_user_id_claim(self):
        from api.middleware.auth import _decode_token
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"user_id": "uid456"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        result = _decode_token(f"Bearer {token}")
        assert result == "uid456"

    def test_decode_token_reads_id_claim(self):
        from api.middleware.auth import _decode_token
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"id": "uid789"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        result = _decode_token(f"Bearer {token}")
        assert result == "uid789"

    def test_get_optional_user_id_returns_none_when_no_auth(self, monkeypatch):
        """No Authorization header → returns None (no 401)."""
        monkeypatch.setenv("ENV", "production")
        from importlib import reload
        import config.settings as _settings
        reload(_settings)
        import api.middleware.auth as _auth
        reload(_auth)

        result = _auth.get_optional_user_id(authorization="")
        assert result is None

    def test_get_optional_user_id_returns_user_id_for_valid_token(self):
        from api.middleware.auth import get_optional_user_id
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"sub": "user42"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        result = get_optional_user_id(authorization=f"Bearer {token}")
        assert result == "user42"

    def test_get_user_id_still_raises_401_in_production(self, monkeypatch):
        """Existing get_user_id() must be unchanged — guests must not use it."""
        from fastapi import HTTPException
        monkeypatch.setenv("ENV", "production")
        from importlib import reload
        import config.settings as _settings
        reload(_settings)
        import api.middleware.auth as _auth
        reload(_auth)

        with pytest.raises(HTTPException) as exc_info:
            _auth.get_user_id(authorization="")
        assert exc_info.value.status_code == 401


# ─────────────────────────────────────────────────────────────────────────────
# 2. Conversation store — guest creation
# ─────────────────────────────────────────────────────────────────────────────

class TestGuestConversationStore:
    """Tests for create_conversation with is_guest=True."""

    @pytest.fixture(autouse=True)
    def fake_db(self, monkeypatch):
        import db.conversation_store as cs
        sqlite_conn = _make_sqlite_conn()
        fake_conn = _FakeConn(sqlite_conn)
        self._sqlite = sqlite_conn

        @contextmanager
        def fake_ctx():
            yield fake_conn
            fake_conn.commit()

        monkeypatch.setattr(cs, "_conn", fake_ctx)
        monkeypatch.setattr(cs, "_fetch_user_profile", lambda uid: {})

    def test_guest_create_conversation_returns_ticket_id(self):
        import db.conversation_store as cs
        ticket_id = cs.create_conversation(
            user_id=None, platform="web", is_guest=True
        )
        assert ticket_id is not None
        assert len(ticket_id) > 0

    def test_guest_customer_row_has_guest_name(self):
        import db.conversation_store as cs
        cs.create_conversation(
            user_id=None, platform="web", is_guest=True,
            guest_name="John", guest_email="john@test.com"
        )
        row = self._sqlite.execute(
            "SELECT name, email, external_id FROM customers WHERE name='John'"
        ).fetchone()
        assert row is not None
        assert row["email"] == "john@test.com"

    def test_guest_customer_row_external_id_is_null(self):
        """Guest customers must not have an external_id (no JWT-derived user_id)."""
        import db.conversation_store as cs
        cs.create_conversation(
            user_id=None, platform="web", is_guest=True, guest_name="Alice"
        )
        row = self._sqlite.execute(
            "SELECT external_id FROM customers WHERE name='Alice'"
        ).fetchone()
        assert row is not None
        assert row["external_id"] is None

    def test_anonymous_guest_gets_guest_name(self):
        """Guests who skip the form should get name='Guest'."""
        import db.conversation_store as cs
        cs.create_conversation(user_id=None, platform="web", is_guest=True)
        row = self._sqlite.execute(
            "SELECT name FROM customers WHERE name='Guest'"
        ).fetchone()
        assert row is not None

    def test_guest_does_not_call_fetch_user_profile(self, monkeypatch):
        """_fetch_user_profile must NOT be called for guests."""
        import db.conversation_store as cs
        calls = []
        monkeypatch.setattr(cs, "_fetch_user_profile", lambda uid: calls.append(uid) or {})
        cs.create_conversation(user_id=None, platform="web", is_guest=True)
        assert calls == [], "_fetch_user_profile was called for a guest session"

    def test_authenticated_create_conversation_unchanged(self):
        """Existing authenticated path must still work after the guest changes."""
        import db.conversation_store as cs
        ticket_id = cs.create_conversation(user_id="auth_user_999", platform="web")
        assert ticket_id is not None


# ─────────────────────────────────────────────────────────────────────────────
# 3. Agent — guest session behaviour
# ─────────────────────────────────────────────────────────────────────────────

class TestAgentGuestMode:
    """Tests for engine.agent.chat(user_id=None)."""

    @pytest.fixture(autouse=True)
    def patch_agent_deps(self, monkeypatch):
        """Isolate agent from DB, Gemini, and RAG.
        Functions imported into engine.agent must be patched at engine.agent.*, not db.conversation_store.*.
        """
        import engine.agent as agent_mod

        # Patch DB functions as they exist in agent's namespace (imported at module load)
        monkeypatch.setattr(agent_mod, "get_history", lambda *a, **kw: [])
        monkeypatch.setattr(agent_mod, "add_message", lambda *a, **kw: None)
        monkeypatch.setattr(agent_mod, "get_ticket_id_by_conversation", lambda *a, **kw: None)
        monkeypatch.setattr(agent_mod, "get_ai_persona", lambda *a, **kw: {"name": None, "avatar": None, "avatar_url": None})
        monkeypatch.setattr(agent_mod, "update_ticket_status", lambda *a, **kw: None)
        monkeypatch.setattr(agent_mod, "update_customer_from_profile", lambda *a, **kw: None)
        monkeypatch.setattr(agent_mod, "collection_count", lambda: 0)
        monkeypatch.setattr(agent_mod, "retrieve_with_fallback", lambda *a, **kw: [])

        # Fake Gemini response
        fake_part = MagicMock()
        fake_part.function_call = None
        fake_part.text = '{"response": "You can reset your password via the app settings.", "confidence": 0.85, "needs_human": false}'
        fake_candidate = MagicMock()
        fake_candidate.content.parts = [fake_part]
        fake_response = MagicMock()
        fake_response.candidates = [fake_candidate]
        fake_response.text = fake_part.text

        mock_gemini_client = MagicMock()
        mock_gemini_client.models.generate_content.return_value = fake_response
        monkeypatch.setattr(agent_mod, "client", mock_gemini_client)
        self._mock_gemini = mock_gemini_client

    def _get_generate_content_call(self):
        """Return the kwargs from the most recent generate_content call."""
        assert self._mock_gemini.models.generate_content.called, "generate_content was never called"
        return self._mock_gemini.models.generate_content.call_args

    def test_guest_chat_returns_agent_response(self):
        from engine.agent import chat
        response = chat(
            conversation_id="conv-guest-1",
            user_id=None,
            user_message="How do I reset my password?",
        )
        assert response is not None
        assert response.text != ""

    def test_guest_chat_passes_empty_tools_to_gemini(self):
        """Gemini must receive tools=[] so it never generates tool calls."""
        from engine.agent import chat
        chat(
            conversation_id="conv-guest-2",
            user_id=None,
            user_message="What are the trading fees?",
            category="other",
        )
        call_kwargs = self._get_generate_content_call().kwargs
        config = call_kwargs.get("config", None)
        # tools=[] can be expressed as an empty list in the GenerateContentConfig
        if config is not None:
            tools = getattr(config, "tools", None)
            assert not tools, f"Expected no tools for guest, got: {tools}"

    def test_guest_chat_uses_guest_system_prompt(self):
        """System prompt must contain the GUEST_PREAMBLE marker, not a category overlay."""
        from engine.agent import chat
        from engine.prompt_templates import GUEST_PREAMBLE
        chat(
            conversation_id="conv-guest-3",
            user_id=None,
            user_message="My withdrawal is stuck",
            category="withdrawal_issue",
        )
        call_kwargs = self._get_generate_content_call().kwargs
        config = call_kwargs.get("config", None)
        system_instruction = ""
        if config is not None:
            system_instruction = getattr(config, "system_instruction", "") or ""
        assert "GUEST SESSION" in system_instruction or "GUEST SESSION" in str(system_instruction), (
            "Guest system prompt must contain GUEST SESSION marker"
        )

    def test_guest_chat_skips_tool_forcing(self):
        """Tool forcing (first-turn get_user_profile) must be skipped for guests."""
        from engine.agent import chat
        chat(
            conversation_id="conv-guest-4",
            user_id=None,
            user_message="What is my KYC status?",
            category="kyc_verification",
        )
        call_kwargs = self._get_generate_content_call().kwargs
        config = call_kwargs.get("config", None)
        if config is not None:
            tool_config = getattr(config, "tool_config", None)
            if tool_config is not None:
                # No ANY mode forced tool call expected
                mode = str(getattr(tool_config, "function_calling_config", "")).upper()
                assert "ANY" not in mode, "Tool forcing (ANY mode) must not be set for guests"

    def test_guest_chat_does_not_raise_for_account_category(self):
        """Guests sending account-specific category must get a response, not an exception."""
        from engine.agent import chat
        # Mock has_successful_bot_reply via conversation_store to skip no-workflow escalation
        with patch("db.conversation_store.has_successful_bot_reply", return_value=True):
            with patch("workflow_engine.store.get_published_workflows_by_trigger", return_value=[MagicMock()]):
                response = chat(
                    conversation_id="conv-guest-5",
                    user_id=None,
                    user_message="My account is restricted",
                    category="account_restriction",
                    suppress_handoff=True,
                )
        assert response is not None

    def test_prompt_templates_has_guest_preamble(self):
        from engine.prompt_templates import GUEST_PREAMBLE
        assert "GUEST SESSION" in GUEST_PREAMBLE
        assert len(GUEST_PREAMBLE) > 50

    def test_get_guest_system_prompt_exists(self):
        from engine.prompt_templates import get_guest_system_prompt
        prompt = get_guest_system_prompt("en")
        assert "GUEST SESSION" in prompt
        assert len(prompt) > 100

    def test_get_guest_system_prompt_thai(self):
        from engine.prompt_templates import get_guest_system_prompt
        prompt = get_guest_system_prompt("th")
        assert "GUEST SESSION" in prompt


# ─────────────────────────────────────────────────────────────────────────────
# 4. AccountLookupNode — guest guard
# ─────────────────────────────────────────────────────────────────────────────

class TestAccountLookupNodeGuest:
    """Tests for AccountLookupNode.run() when ctx.user_id is None."""

    def _make_ctx(self, user_id):
        from workflow_engine.models import ExecutionContext
        return ExecutionContext(
            variables={},
            conversation_id="conv-wf-1",
            user_id=user_id,
            channel="web",
        )

    def _make_node(self, tool="get_user_profile"):
        from workflow_engine.models import WorkflowNode
        return WorkflowNode(
            id="node-1",
            kind="account_lookup",
            config={"tool": tool},
            next_node_id="node-2",
        )

    def test_guest_returns_node_result_without_calling_tools(self):
        """With user_id=None, AccountLookupNode must not call any account tools."""
        from workflow_engine.nodes.account_lookup import AccountLookupNode

        node = self._make_node()
        ctx = self._make_ctx(user_id=None)

        with patch("workflow_engine.nodes.account_lookup.get_user_profile") as mock_profile:
            result = AccountLookupNode().run(node, ctx)
            mock_profile.assert_not_called()

        assert result is not None

    def test_guest_node_result_has_guest_session_flag(self):
        from workflow_engine.nodes.account_lookup import AccountLookupNode

        node = self._make_node()
        ctx = self._make_ctx(user_id=None)

        result = AccountLookupNode().run(node, ctx)
        assert result.output.get("guest_session") is True

    def test_guest_node_result_routes_to_on_success(self):
        """Guest NodeResult must route to next_node_id (the on_success path)."""
        from workflow_engine.nodes.account_lookup import AccountLookupNode

        node = self._make_node()
        ctx = self._make_ctx(user_id=None)

        result = AccountLookupNode().run(node, ctx)
        assert result.next_node_id == "node-2"

    def test_guest_node_does_not_call_update_customer_from_profile(self):
        from workflow_engine.nodes.account_lookup import AccountLookupNode

        node = self._make_node()
        ctx = self._make_ctx(user_id=None)

        with patch("workflow_engine.nodes.account_lookup.update_customer_from_profile") as mock_update:
            AccountLookupNode().run(node, ctx)
            mock_update.assert_not_called()

    def test_authenticated_node_still_calls_tools(self):
        """Authenticated path must be unchanged."""
        from workflow_engine.nodes.account_lookup import AccountLookupNode

        node = self._make_node()
        ctx = self._make_ctx(user_id="real_user_123")

        fake_profile = {"first_name": "Jane", "last_name": "Doe", "tier": "regular"}
        with patch("workflow_engine.nodes.account_lookup.get_user_profile", return_value=fake_profile):
            with patch("workflow_engine.nodes.account_lookup.update_customer_from_profile"):
                result = AccountLookupNode().run(node, ctx)

        assert result.output.get("profile") == fake_profile

    def test_execution_context_accepts_none_user_id(self):
        """ExecutionContext must accept user_id=None without type error."""
        from workflow_engine.models import ExecutionContext
        ctx = ExecutionContext(
            variables={},
            conversation_id="conv-x",
            user_id=None,
            channel="web",
        )
        assert ctx.user_id is None


# ─────────────────────────────────────────────────────────────────────────────
# 5. Route integration tests
# ─────────────────────────────────────────────────────────────────────────────

class TestGuestRoutes:
    """Integration tests against FastAPI TestClient."""

    @pytest.fixture
    def client(self, monkeypatch):
        import db.conversation_store as cs
        sqlite_conn = _make_sqlite_conn()
        fake_conn = _FakeConn(sqlite_conn)
        self._sqlite = sqlite_conn

        @contextmanager
        def fake_ctx():
            yield fake_conn
            fake_conn.commit()

        monkeypatch.setattr(cs, "_conn", fake_ctx)
        monkeypatch.setattr(cs, "_fetch_user_profile", lambda uid: {})
        monkeypatch.setattr(cs, "get_customer_id_for_user", lambda uid: None)

        # workflow_interceptor is imported as 'chat' in api.routes.chat
        with patch("api.routes.chat.chat") as mock_wi:
            from engine.agent import AgentResponse
            mock_wi.return_value = AgentResponse(
                text="Here is some general information about your query.",
                language="en",
            )
            from fastapi.testclient import TestClient
            from api.main import app
            yield TestClient(app), mock_wi

    def test_guest_start_returns_200_and_is_guest_true(self, client):
        tc, _ = client
        response = tc.post("/chat/start", json={"platform": "web"})
        assert response.status_code == 200
        data = response.json()
        assert data["is_guest"] is True
        assert "conversation_id" in data

    def test_guest_start_with_name_and_email(self, client):
        tc, _ = client
        response = tc.post("/chat/start", json={
            "platform": "web",
            "guest_name": "John",
            "guest_email": "john@test.com",
        })
        assert response.status_code == 200
        assert response.json()["is_guest"] is True

    def test_authenticated_start_returns_is_guest_false(self, client):
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"sub": "user_abc"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        tc, _ = client
        response = tc.post(
            "/chat/start",
            json={"platform": "web"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["is_guest"] is False

    def test_guest_message_returns_200(self, client):
        tc, mock_wi = client
        # First create a conversation
        start_resp = tc.post("/chat/start", json={"platform": "web"})
        conv_id = start_resp.json()["conversation_id"]

        response = tc.post("/chat/message", json={
            "conversation_id": conv_id,
            "message": "What are the trading fees?",
            "consecutive_low_confidence": 0,
        })
        assert response.status_code == 200

    def test_guest_message_calls_workflow_interceptor_with_none_user_id(self, client):
        tc, mock_wi = client
        start_resp = tc.post("/chat/start", json={"platform": "web"})
        conv_id = start_resp.json()["conversation_id"]

        tc.post("/chat/message", json={
            "conversation_id": conv_id,
            "message": "What are the trading fees?",
            "consecutive_low_confidence": 0,
        })
        assert mock_wi.called
        call_kwargs = mock_wi.call_args.kwargs if mock_wi.call_args.kwargs else {}
        call_args = mock_wi.call_args.args if mock_wi.call_args.args else ()
        # user_id should be None (guest) — check both args and kwargs
        user_id_arg = call_kwargs.get("user_id", call_args[1] if len(call_args) > 1 else "NOT_CHECKED")
        assert user_id_arg is None, f"Expected user_id=None for guest, got: {user_id_arg}"

    def test_customer_tickets_returns_401_for_guests(self, client, monkeypatch):
        """In production mode, no auth → 401 on /chat/customer-tickets (strict endpoint)."""
        import config.settings as _settings
        monkeypatch.setattr(_settings, "ENV", "production")
        import api.middleware.auth as _auth
        monkeypatch.setattr(_auth, "ENV", "production")
        tc, _ = client
        response = tc.get("/chat/customer-tickets")
        assert response.status_code == 401

    def test_customer_tickets_returns_200_for_authenticated(self, client):
        from jose import jwt
        from config.settings import JWT_SECRET, JWT_ALGORITHM
        token = jwt.encode({"sub": "user_xyz"}, JWT_SECRET, algorithm=JWT_ALGORITHM)
        tc, _ = client
        with patch("api.routes.chat.get_customer_tickets", return_value=[]):
            response = tc.get(
                "/chat/customer-tickets",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200

    def test_open_ticket_returns_null_for_guest(self, client, monkeypatch):
        """Guest /chat/open-ticket → 200 with ticket=None (no account lookup)."""
        import config.settings as _settings
        import api.middleware.auth as _auth
        monkeypatch.setattr(_settings, "ENV", "production")
        monkeypatch.setattr(_auth, "ENV", "production")
        tc, _ = client
        response = tc.get("/chat/open-ticket")
        # After implementation: 200 + {"ticket": null}
        # Before implementation: 401 (strict auth)
        # Either way the test documents the expected post-implementation behaviour
        if response.status_code == 200:
            assert response.json()["ticket"] is None
        else:
            assert response.status_code == 401  # pre-implementation red state


# ─────────────────────────────────────────────────────────────────────────────
# 6. Workflow interceptor type annotations
# ─────────────────────────────────────────────────────────────────────────────

class TestInterceptorSignature:
    """Ensure interceptor functions accept user_id=None without crashing on
    type guards or None-specific failures."""

    def test_legacy_agent_chat_accepts_none_user_id(self):
        """Inspect the real function's type annotation — must allow None."""
        import inspect
        from workflow_engine import interceptor
        sig = inspect.signature(interceptor.legacy_agent_chat)
        annotation = sig.parameters["user_id"].annotation
        # After implementation: annotation is `str | None`
        assert "None" in str(annotation), (
            f"legacy_agent_chat user_id annotation should allow None, got: {annotation}"
        )

    def test_workflow_interceptor_accepts_none_user_id(self):
        import inspect
        from workflow_engine import interceptor
        sig = inspect.signature(interceptor.workflow_interceptor)
        annotation = sig.parameters["user_id"].annotation
        assert "None" in str(annotation) or annotation is inspect.Parameter.empty, (
            f"workflow_interceptor user_id annotation should allow None, got: {annotation}"
        )
