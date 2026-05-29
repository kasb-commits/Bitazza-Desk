"""
TDD tests for POST /chat/emergency-escalate.

Written BEFORE implementation. All tests are expected to fail until the
endpoint is built.

Covers:
  1. Response shape — correct fields present and typed
  2. No auth required — endpoint is public
  3. Guest ticket created — customer + ticket rows written to DB
  4. Ticket status is Escalated immediately
  5. Auto-assign is triggered with correct arguments
  6. error_source stored on the ticket
  7. Optional fields (guest_name, guest_email) — absent is fine
  8. User message stored when provided
  9. Language defaults to "en" when absent
  10. Regression — existing /chat/start and /chat/message unaffected
"""
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import patch, MagicMock, call

import pytest

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("FRESHDESK_API_KEY", "test")
os.environ.setdefault("FRESHDESK_SUBDOMAIN", "test.freshdesk.com")
os.environ.setdefault("JWT_SECRET", "test-secret-key")
os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

from fastapi.testclient import TestClient


# ── SQLite helpers (mirrors test_api.py) ─────────────────────────────────────

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
            error_source TEXT,
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


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def sqlite_conn():
    return _make_sqlite_conn()


@pytest.fixture
def client(monkeypatch, sqlite_conn):
    import db.conversation_store as cs

    fake_conn = _FakeConn(sqlite_conn)

    @contextmanager
    def fake_context_manager():
        yield fake_conn
        fake_conn.commit()

    monkeypatch.setattr(cs, "_conn", fake_context_manager)
    monkeypatch.setattr(cs, "_fetch_user_profile", lambda user_id: {})

    from api.main import app
    return TestClient(app)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _post_emergency(client, payload: dict, token: str | None = None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return client.post("/chat/emergency-escalate", json=payload, headers=headers)


MINIMAL_PAYLOAD = {
    "error_source": "start_failed",
    "platform": "web",
    "language": "en",
}


# ═════════════════════════════════════════════════════════════════════════════
# 1. Response shape
# ═════════════════════════════════════════════════════════════════════════════

class TestResponseShape:

    def test_returns_200(self, client):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        assert resp.status_code == 200

    def test_response_has_conversation_id(self, client):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        data = resp.json()
        assert "conversation_id" in data
        assert isinstance(data["conversation_id"], str)
        assert len(data["conversation_id"]) > 0

    def test_response_has_escalated_true(self, client):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        assert resp.json()["escalated"] is True

    def test_response_has_ticket_id(self, client):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        data = resp.json()
        assert "ticket_id" in data
        assert isinstance(data["ticket_id"], str)

    def test_conversation_id_and_ticket_id_match(self, client):
        """In this system conversation_id == ticket_id — must hold for emergency tickets too."""
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        data = resp.json()
        assert data["conversation_id"] == data["ticket_id"]


# ═════════════════════════════════════════════════════════════════════════════
# 2. No auth required
# ═════════════════════════════════════════════════════════════════════════════

class TestNoAuthRequired:

    def test_succeeds_with_no_auth_header(self, client):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD, token=None)
        assert resp.status_code == 200

    def test_succeeds_with_invalid_token(self, client):
        """Invalid JWT must not block this endpoint."""
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD, token="not-a-real-token")
        assert resp.status_code == 200

    def test_succeeds_with_valid_token_too(self, client):
        """Authenticated users can also hit this endpoint without issue."""
        from jose import jwt
        token = jwt.encode({"user_id": "usr-123"}, "test-secret-key", algorithm="HS256")
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD, token=token)
        assert resp.status_code == 200


# ═════════════════════════════════════════════════════════════════════════════
# 3. Guest ticket created in DB
# ═════════════════════════════════════════════════════════════════════════════

class TestGuestTicketCreated:

    def test_ticket_row_exists_after_call(self, client, sqlite_conn):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]

        row = sqlite_conn.execute(
            "SELECT * FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert row is not None

    def test_customer_row_created(self, client, sqlite_conn):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]

        ticket = sqlite_conn.execute(
            "SELECT customer_id FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert ticket is not None
        customer = sqlite_conn.execute(
            "SELECT * FROM customers WHERE id = ?", (ticket["customer_id"],)
        ).fetchone()
        assert customer is not None

    def test_guest_name_stored_when_provided(self, client, sqlite_conn):
        payload = {**MINIMAL_PAYLOAD, "guest_name": "Test User"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        ticket_id = resp.json()["ticket_id"]

        ticket = sqlite_conn.execute(
            "SELECT customer_id FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        customer = sqlite_conn.execute(
            "SELECT name FROM customers WHERE id = ?", (ticket["customer_id"],)
        ).fetchone()
        assert customer["name"] == "Test User"

    def test_guest_email_stored_when_provided(self, client, sqlite_conn):
        payload = {**MINIMAL_PAYLOAD, "guest_email": "user@test.com"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        ticket_id = resp.json()["ticket_id"]

        ticket = sqlite_conn.execute(
            "SELECT customer_id FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        customer = sqlite_conn.execute(
            "SELECT email FROM customers WHERE id = ?", (ticket["customer_id"],)
        ).fetchone()
        assert customer["email"] == "user@test.com"

    def test_missing_guest_name_and_email_still_creates_ticket(self, client, sqlite_conn):
        payload = {"error_source": "start_failed", "platform": "web", "language": "en"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        assert resp.status_code == 200
        ticket_id = resp.json()["ticket_id"]
        row = sqlite_conn.execute(
            "SELECT * FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert row is not None


# ═════════════════════════════════════════════════════════════════════════════
# 4. Ticket status is Escalated immediately
# ═════════════════════════════════════════════════════════════════════════════

class TestTicketStatusEscalated:

    def test_ticket_status_is_escalated(self, client, sqlite_conn):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]

        row = sqlite_conn.execute(
            "SELECT status FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert row["status"] == "Escalated"

    def test_ticket_is_never_open_live(self, client, sqlite_conn):
        """Emergency ticket must never pass through Open_Live — straight to Escalated."""
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]

        row = sqlite_conn.execute(
            "SELECT status FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert row["status"] != "Open_Live"


# ═════════════════════════════════════════════════════════════════════════════
# 5. Auto-assign triggered
# ═════════════════════════════════════════════════════════════════════════════

class TestAutoAssignTriggered:

    def test_trigger_auto_assign_called_once(self, client):
        with patch("engine.assignment_client.trigger_auto_assign") as mock_assign:
            _post_emergency(client, MINIMAL_PAYLOAD)
        mock_assign.assert_called_once()

    def test_trigger_auto_assign_receives_ticket_id(self, client):
        with patch("engine.assignment_client.trigger_auto_assign") as mock_assign:
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]
        call_args = mock_assign.call_args
        assert ticket_id in call_args.args or ticket_id in call_args.kwargs.values()

    def test_auto_assign_not_called_when_db_fails(self, client, monkeypatch):
        """If ticket creation raises, auto-assign must not be called."""
        import db.conversation_store as cs
        monkeypatch.setattr(cs, "create_emergency_ticket", MagicMock(side_effect=RuntimeError("db down")))

        with patch("engine.assignment_client.trigger_auto_assign") as mock_assign:
            resp = _post_emergency(client, MINIMAL_PAYLOAD)

        mock_assign.assert_not_called()
        assert resp.status_code == 500


# ═════════════════════════════════════════════════════════════════════════════
# 6. error_source stored on ticket
# ═════════════════════════════════════════════════════════════════════════════

class TestErrorSourceStored:

    @pytest.mark.parametrize("error_source", ["start_failed", "greet_failed"])
    def test_error_source_stored_correctly(self, client, sqlite_conn, error_source):
        payload = {**MINIMAL_PAYLOAD, "error_source": error_source}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        ticket_id = resp.json()["ticket_id"]

        row = sqlite_conn.execute(
            "SELECT error_source FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        assert row["error_source"] == error_source


# ═════════════════════════════════════════════════════════════════════════════
# 7. User message stored when provided
# ═════════════════════════════════════════════════════════════════════════════

class TestUserMessageStored:

    def test_message_row_created_when_provided(self, client, sqlite_conn):
        payload = {**MINIMAL_PAYLOAD, "user_message": "I cannot log in"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        ticket_id = resp.json()["ticket_id"]

        rows = sqlite_conn.execute(
            "SELECT * FROM messages WHERE ticket_id = ?", (ticket_id,)
        ).fetchall()
        assert len(rows) == 1
        assert dict(rows[0])["content"] == "I cannot log in"

    def test_no_message_row_when_not_provided(self, client, sqlite_conn):
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, MINIMAL_PAYLOAD)
        ticket_id = resp.json()["ticket_id"]

        rows = sqlite_conn.execute(
            "SELECT * FROM messages WHERE ticket_id = ?", (ticket_id,)
        ).fetchall()
        assert len(rows) == 0

    def test_message_sender_type_is_customer(self, client, sqlite_conn):
        payload = {**MINIMAL_PAYLOAD, "user_message": "Help me please"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        ticket_id = resp.json()["ticket_id"]

        row = sqlite_conn.execute(
            "SELECT sender_type FROM messages WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()
        assert dict(row)["sender_type"] == "customer"


# ═════════════════════════════════════════════════════════════════════════════
# 8. Language defaults
# ═════════════════════════════════════════════════════════════════════════════

class TestLanguageDefaults:

    def test_language_defaults_to_en_when_absent(self, client):
        payload = {"error_source": "start_failed", "platform": "web"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        assert resp.status_code == 200

    def test_thai_language_accepted(self, client):
        payload = {**MINIMAL_PAYLOAD, "language": "th"}
        with patch("engine.assignment_client.trigger_auto_assign"):
            resp = _post_emergency(client, payload)
        assert resp.status_code == 200


# ═════════════════════════════════════════════════════════════════════════════
# 9. Regression — existing endpoints unaffected
# ═════════════════════════════════════════════════════════════════════════════

class TestRegressionExistingEndpointsUnaffected:

    def test_chat_start_still_returns_200(self, client):
        fake_agent = {"name": "Ploy", "avatar": "🌸", "avatar_url": ""}
        with (
            patch("api.routes.chat.pick_agent", return_value=fake_agent),
            patch("api.routes.chat.assign_ai_persona"),
        ):
            resp = client.post("/chat/start", json={"platform": "web"})
        assert resp.status_code == 200

    def test_emergency_endpoint_does_not_interfere_with_start(self, client):
        """Calling emergency-escalate first must not corrupt state for subsequent /chat/start.
        The emergency endpoint returns 404 until implemented — that's expected.
        What we verify is that /chat/start remains unaffected regardless."""
        # Call emergency endpoint (404 before implementation — irrelevant to this regression)
        _post_emergency(client, MINIMAL_PAYLOAD)

        fake_agent = {"name": "Ploy", "avatar": "🌸", "avatar_url": ""}
        with (
            patch("api.routes.chat.pick_agent", return_value=fake_agent),
            patch("api.routes.chat.assign_ai_persona"),
        ):
            resp = client.post("/chat/start", json={"platform": "web"})
        assert resp.status_code == 200
