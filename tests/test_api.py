"""Integration tests for the FastAPI endpoints using TestClient."""
import pytest
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("FRESHDESK_API_KEY", "test")
os.environ.setdefault("FRESHDESK_SUBDOMAIN", "test.freshdesk.com")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Shared SQLite fake helpers (mirrors the same helpers in test_conversation_store.py)
# ---------------------------------------------------------------------------

def _make_sqlite_conn():
    """Create an in-memory SQLite DB with the same schema as PostgreSQL."""
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
    """Wraps sqlite3 cursor to behave like psycopg2 RealDictCursor.
    Translates %s placeholders to ? for sqlite3 compatibility.
    """
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
        pass  # keep in-memory DB alive


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_chat_start(client):
    r = client.post("/chat/start", json={"platform": "bitazza"})
    assert r.status_code == 200
    data = r.json()
    assert "conversation_id" in data
    assert len(data["conversation_id"]) == 36


def test_chat_message_calls_agent(client):
    # Start conversation
    r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    # Mock the agent so we don't need a real Gemini key
    mock_result = MagicMock()
    mock_result.text = "Your KYC is currently pending."
    mock_result.language = "en"
    mock_result.escalated = False
    mock_result.escalation_reason = ""
    mock_result.ticket_id = None
    mock_result.agent_name = None
    mock_result.agent_avatar = None
    mock_result.agent_avatar_url = None
    mock_result.confidence = 0.9
    mock_result.resolved = False
    mock_result.specialist_intro = None
    mock_result.confidence = 1.0
    mock_result.upgraded_category = None
    mock_result.transition_message = None

    with patch("api.routes.chat.chat", return_value=mock_result):
        r = client.post("/chat/message", json={
            "conversation_id": conv_id,
            "message": "What is my KYC status?",
        })

    assert r.status_code == 200
    data = r.json()
    assert data["reply"] == "Your KYC is currently pending."
    assert data["escalated"] is False


def test_chat_message_empty_blocked(client):
    r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]
    r = client.post("/chat/message", json={"conversation_id": conv_id, "message": "  "})
    assert r.status_code == 400


def test_dashboard_tickets_empty(client):
    r = client.get("/api/tickets")
    assert r.status_code == 200
    assert r.json()["tickets"] == []


def test_dashboard_ticket_not_found(client):
    r = client.get("/api/tickets/nonexistent-id")
    assert r.status_code == 404


def test_chat_history(client):
    r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]
    r = client.get(f"/chat/history/{conv_id}")
    assert r.status_code == 200
    assert "history" in r.json()
