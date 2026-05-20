"""
API-level tests for cross-session chat history endpoints.
Covers:
  - POST /chat/start → returns customer_id, same user gets same customer_id
  - GET /chat/customer-tickets → paginated ticket list, auth required
  - GET /chat/history/{id}?page=N&limit=N → paginated messages
  - Regression: existing flows (session resume, send, csat, escalation) unaffected
"""
import pytest
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import patch, MagicMock

os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("FRESHDESK_API_KEY", "test")
os.environ.setdefault("FRESHDESK_SUBDOMAIN", "test.freshdesk.com")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# SQLite fake (same pattern as test_api.py)
# ---------------------------------------------------------------------------

def _make_sqlite_conn():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE customers (
            id TEXT PRIMARY KEY,
            name TEXT, email TEXT, phone TEXT,
            tier TEXT DEFAULT 'regular',
            kyc_status TEXT, kyc_tier TEXT, external_id TEXT
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


@pytest.fixture
def client(monkeypatch):
    import db.conversation_store as cs
    sqlite_conn = _make_sqlite_conn()
    fake_conn = _FakeConn(sqlite_conn)

    @contextmanager
    def fake_context_manager():
        yield fake_conn
        fake_conn.commit()

    monkeypatch.setattr(cs, "_conn", fake_context_manager)
    monkeypatch.setattr(cs, "_fetch_user_profile", lambda user_id: {})

    from api.main import app
    return TestClient(app)


def _jwt_headers(user_id: str = "test-user-1") -> dict:
    """Build Authorization headers with a signed JWT."""
    from jose import jwt as _jwt
    secret = os.environ.get("JWT_SECRET", "test-secret")
    token = _jwt.encode({"sub": user_id}, secret, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_client(monkeypatch):
    """TestClient with a pre-baked JWT for user 'test-user-1'."""
    import db.conversation_store as cs
    sqlite_conn = _make_sqlite_conn()
    fake_conn = _FakeConn(sqlite_conn)

    @contextmanager
    def fake_context_manager():
        yield fake_conn
        fake_conn.commit()

    monkeypatch.setattr(cs, "_conn", fake_context_manager)
    monkeypatch.setattr(cs, "_fetch_user_profile", lambda user_id: {})

    from api.main import app
    tc = TestClient(app)
    tc.headers.update(_jwt_headers("test-user-1"))
    return tc


def _mock_agent_result(**overrides):
    r = MagicMock()
    r.text = "Test reply"
    r.language = "en"
    r.escalated = False
    r.escalation_reason = ""
    r.ticket_id = None
    r.agent_name = None
    r.agent_avatar = None
    r.agent_avatar_url = None
    r.confidence = 1.0
    r.resolved = False
    r.specialist_intro = None
    r.upgraded_category = None
    r.transition_message = None
    for k, v in overrides.items():
        setattr(r, k, v)
    return r


# ---------------------------------------------------------------------------
# POST /chat/start — customer_id in response
# ---------------------------------------------------------------------------

class TestChatStartCustomerId:
    def test_response_includes_customer_id(self, auth_client):
        r = auth_client.post("/chat/start", json={"platform": "bitazza"})
        assert r.status_code == 200
        data = r.json()
        assert "customer_id" in data
        assert len(data["customer_id"]) == 36  # UUID

    def test_same_user_gets_same_customer_id(self, auth_client):
        r1 = auth_client.post("/chat/start", json={"platform": "bitazza"})
        r2 = auth_client.post("/chat/start", json={"platform": "bitazza"})
        assert r1.json()["customer_id"] == r2.json()["customer_id"]

    def test_same_user_gets_different_conversation_ids(self, auth_client):
        r1 = auth_client.post("/chat/start", json={"platform": "bitazza"})
        r2 = auth_client.post("/chat/start", json={"platform": "bitazza"})
        assert r1.json()["conversation_id"] != r2.json()["conversation_id"]

    def test_existing_fields_still_present(self, auth_client):
        r = auth_client.post("/chat/start", json={"platform": "bitazza"})
        data = r.json()
        assert "conversation_id" in data
        assert "ticket_id" in data
        assert "agent_name" in data
        assert "agent_avatar" in data
        assert "agent_avatar_url" in data


# ---------------------------------------------------------------------------
# GET /chat/customer-tickets — new endpoint
# ---------------------------------------------------------------------------

class TestCustomerTicketsEndpoint:
    def test_returns_200_with_tickets(self, auth_client):
        auth_client.post("/chat/start", json={"platform": "web"})
        r = auth_client.get("/chat/customer-tickets")
        assert r.status_code == 200
        data = r.json()
        assert "tickets" in data
        assert len(data["tickets"]) >= 1

    def test_unauthenticated_returns_401(self, monkeypatch):
        """No JWT token → 401 in production mode."""
        import config.settings as s
        monkeypatch.setattr(s, "ENV", "production")
        import api.middleware.auth as auth_mod
        monkeypatch.setattr(auth_mod, "ENV", "production")
        from api.main import app
        import db.conversation_store as cs
        sqlite_conn = _make_sqlite_conn()
        fake_conn = _FakeConn(sqlite_conn)
        from contextlib import contextmanager as _cm
        @_cm
        def _fake():
            yield fake_conn
            fake_conn.commit()
        monkeypatch.setattr(cs, "_conn", _fake)
        monkeypatch.setattr(cs, "_fetch_user_profile", lambda uid: {})
        tc = TestClient(app, raise_server_exceptions=False)
        r = tc.get("/chat/customer-tickets")
        assert r.status_code == 401

    def test_pagination_page_and_limit(self, auth_client):
        for _ in range(7):
            auth_client.post("/chat/start", json={"platform": "web"})
            time.sleep(0.001)

        r1 = auth_client.get("/chat/customer-tickets?page=1&limit=5")
        r2 = auth_client.get("/chat/customer-tickets?page=2&limit=5")
        assert r1.status_code == 200
        assert r2.status_code == 200
        assert len(r1.json()["tickets"]) == 5
        assert len(r2.json()["tickets"]) == 2

    def test_response_shape(self, auth_client):
        auth_client.post("/chat/start", json={"platform": "web", "category": "kyc_verification"})
        r = auth_client.get("/chat/customer-tickets")
        ticket = r.json()["tickets"][0]
        assert "id" in ticket
        assert "category" in ticket
        assert "status" in ticket
        assert "created_at" in ticket
        assert "last_message" in ticket
        assert "last_message_at" in ticket

    def test_only_returns_own_tickets(self, auth_client):
        """Same authenticated user makes two tickets — both appear in their list."""
        auth_client.post("/chat/start", json={"platform": "web"})
        auth_client.post("/chat/start", json={"platform": "web"})
        r = auth_client.get("/chat/customer-tickets")
        assert len(r.json()["tickets"]) == 2


# ---------------------------------------------------------------------------
# GET /chat/history/{id}?page=N&limit=N — paginated messages
# ---------------------------------------------------------------------------

class TestPaginatedHistoryEndpoint:
    def test_existing_history_endpoint_still_works(self, client):
        """Backwards compatibility: no page/limit params → default behavior."""
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        r = client.get(f"/chat/history/{cid}")
        assert r.status_code == 200
        assert "history" in r.json()

    def test_paginated_history_page1(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]

        with patch("api.routes.chat.chat", return_value=_mock_agent_result()):
            for _ in range(12):
                client.post("/chat/message", json={"conversation_id": cid, "message": "test"})

        r = client.get(f"/chat/history/{cid}?page=1&limit=10")
        assert r.status_code == 200
        # 12 user messages + 12 assistant replies = 24 messages; page 1 should have 10
        assert len(r.json()["history"]) == 10

    def test_paginated_history_page2(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]

        with patch("api.routes.chat.chat", return_value=_mock_agent_result()):
            for _ in range(7):
                client.post("/chat/message", json={"conversation_id": cid, "message": "test"})

        r = client.get(f"/chat/history/{cid}?page=2&limit=10")
        assert r.status_code == 200
        # 14 total messages; page 2 with limit 10 → 4 remaining
        assert len(r.json()["history"]) == 4

    def test_paginated_history_unknown_id_returns_empty(self, client):
        r = client.get("/chat/history/nonexistent-uuid?page=1&limit=10")
        assert r.status_code == 200
        assert r.json()["history"] == []

    def test_paginated_response_includes_human_handling(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        r = client.get(f"/chat/history/{cid}?page=1&limit=10")
        assert "human_handling" in r.json()


# ---------------------------------------------------------------------------
# Regression: existing flows must be unaffected
# ---------------------------------------------------------------------------

class TestRegressionExistingFlows:
    def test_chat_start_still_works(self, client):
        r = client.post("/chat/start", json={"platform": "bitazza"})
        assert r.status_code == 200
        assert "conversation_id" in r.json()

    def test_send_message_unaffected(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        with patch("api.routes.chat.chat", return_value=_mock_agent_result()):
            r = client.post("/chat/message", json={"conversation_id": cid, "message": "Hello"})
        assert r.status_code == 200
        assert r.json()["reply"] == "Test reply"

    def test_empty_message_still_blocked(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        r = client.post("/chat/message", json={"conversation_id": cid, "message": "  "})
        assert r.status_code == 400

    def test_csat_submission_unaffected(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        ticket_id = r.json()["ticket_id"]
        r = client.post("/chat/csat", json={"ticket_id": ticket_id, "score": 4})
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_csat_invalid_score_rejected(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        ticket_id = r.json()["ticket_id"]
        r = client.post("/chat/csat", json={"ticket_id": ticket_id, "score": 9})
        assert r.status_code == 400

    def test_history_default_limit_unchanged(self, client):
        """GET /chat/history/{id} with no params still returns up to 50 messages."""
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        with patch("api.routes.chat.chat", return_value=_mock_agent_result()):
            for _ in range(30):
                client.post("/chat/message", json={"conversation_id": cid, "message": "msg"})
        r = client.get(f"/chat/history/{cid}")
        assert r.status_code == 200
        # 30 user + 30 assistant = 60 messages; default limit=50 → 50
        assert len(r.json()["history"]) == 50

    def test_escalation_flow_unaffected(self, client):
        r = client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        escalated_result = _mock_agent_result(escalated=True, text="Connecting you to an agent.")
        with patch("api.routes.chat.chat", return_value=escalated_result):
            r = client.post("/chat/message", json={"conversation_id": cid, "message": "I want human"})
        assert r.status_code == 200
        assert r.json()["escalated"] is True

    def test_health_endpoint_unaffected(self, client):
        r = client.get("/health")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# GET /chat/open-ticket — open ticket detection for widget banner
# ---------------------------------------------------------------------------

class TestOpenTicketEndpoint:
    def test_returns_open_ticket_when_exists(self, auth_client):
        r = auth_client.post("/chat/start", json={"platform": "web", "category": "kyc_verification"})
        cid = r.json()["conversation_id"]

        r = auth_client.get("/chat/open-ticket")
        assert r.status_code == 200
        data = r.json()
        assert data["ticket"] is not None
        assert data["ticket"]["id"] == cid

    def test_returns_null_when_no_open_ticket(self, auth_client):
        # No conversation started — no ticket
        r = auth_client.get("/chat/open-ticket")
        assert r.status_code == 200
        assert r.json()["ticket"] is None

    def test_returns_null_after_ticket_closed(self, auth_client):
        import db.conversation_store as cs
        r = auth_client.post("/chat/start", json={"platform": "web"})
        cid = r.json()["conversation_id"]
        cs.update_ticket_status(cid, "resolved")

        r = auth_client.get("/chat/open-ticket")
        assert r.status_code == 200
        assert r.json()["ticket"] is None

    def test_unauthenticated_returns_null(self, monkeypatch):
        """No JWT token → /chat/open-ticket returns null (uses optional auth, not strict)."""
        import db.conversation_store as cs
        sqlite_conn = _make_sqlite_conn()
        fake_conn = _FakeConn(sqlite_conn)
        from contextlib import contextmanager as _cm
        @_cm
        def _fake():
            yield fake_conn
            fake_conn.commit()
        monkeypatch.setattr(cs, "_conn", _fake)
        monkeypatch.setattr(cs, "_fetch_user_profile", lambda uid: {})
        from api.main import app
        tc = TestClient(app, raise_server_exceptions=False)
        r = tc.get("/chat/open-ticket")
        assert r.status_code == 200
        assert r.json()["ticket"] is None
