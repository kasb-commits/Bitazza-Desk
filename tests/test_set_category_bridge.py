"""
Tests for the set-category bridge message logic.

When a customer goes back and selects a different category mid-conversation,
the /chat/set-category endpoint should insert a system message into the thread
so agents can see the topic switch in the dashboard inbox.
"""
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime

import pytest

os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("FRESHDESK_API_KEY", "test")
os.environ.setdefault("FRESHDESK_SUBDOMAIN", "test.freshdesk.com")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

from fastapi.testclient import TestClient
from unittest.mock import patch


# ─── SQLite in-memory helpers (same pattern as test_api.py) ─────────────────

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


# ─── Fixture ─────────────────────────────────────────────────────────────────

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


CONV_ID = "aaaaaaaa-0000-0000-0000-000000000001"


def _seed_ticket(client, conv_id: str, category: str):
    """Start a conversation and set an initial category so the ticket exists."""
    with patch("api.routes.chat.trigger_auto_assign"):
        client.post("/chat/start", json={"platform": "web"})
    # Directly seed via set-category (first call — no bridge message expected)
    client.post("/chat/set-category", json={
        "conversation_id": conv_id,
        "category": category,
    })


# ─── Tests ───────────────────────────────────────────────────────────────────

def test_first_category_selection_no_bridge_message(client):
    """First set-category call should NOT insert a system message."""
    with patch("api.routes.chat.trigger_auto_assign"):
        r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    client.post("/chat/set-category", json={
        "conversation_id": conv_id,
        "category": "kyc_verification",
    })

    history = client.get(f"/chat/history/{conv_id}").json()["history"]
    system_msgs = [m for m in history if m["role"] == "system"]
    assert system_msgs == [], "No system message expected on first category pick"


def test_category_switch_inserts_bridge_message(client):
    """Switching from one category to another inserts a system bridge message."""
    with patch("api.routes.chat.trigger_auto_assign"):
        r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    # First pick: KYC
    client.post("/chat/set-category", json={
        "conversation_id": conv_id,
        "category": "kyc_verification",
    })

    # Customer goes back and picks a different category
    client.post("/chat/set-category", json={
        "conversation_id": conv_id,
        "category": "account_restriction",
    })

    history = client.get(f"/chat/history/{conv_id}").json()["history"]
    system_msgs = [m for m in history if m["role"] == "system"]
    assert len(system_msgs) == 1
    assert "KYC Verification" in system_msgs[0]["content"]
    assert "Account Restriction" in system_msgs[0]["content"]


def test_bridge_message_content_format(client):
    """Bridge message uses the → arrow format agents expect."""
    with patch("api.routes.chat.trigger_auto_assign"):
        r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "kyc_verification"})
    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "withdrawal_issue"})

    history = client.get(f"/chat/history/{conv_id}").json()["history"]
    system_msgs = [m for m in history if m["role"] == "system"]
    assert "KYC Verification → Withdrawal Issue" in system_msgs[0]["content"]


def test_same_category_reselect_no_bridge_message(client):
    """Re-selecting the same category (edge case) should not insert a bridge message."""
    with patch("api.routes.chat.trigger_auto_assign"):
        r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "kyc_verification"})
    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "kyc_verification"})

    history = client.get(f"/chat/history/{conv_id}").json()["history"]
    system_msgs = [m for m in history if m["role"] == "system"]
    assert system_msgs == [], "No bridge message when category does not change"


def test_multiple_switches_each_get_a_bridge_message(client):
    """Each category switch gets its own bridge message."""
    with patch("api.routes.chat.trigger_auto_assign"):
        r = client.post("/chat/start", json={"platform": "web"})
    conv_id = r.json()["conversation_id"]

    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "kyc_verification"})
    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "account_restriction"})
    client.post("/chat/set-category", json={"conversation_id": conv_id, "category": "fraud_security"})

    history = client.get(f"/chat/history/{conv_id}").json()["history"]
    system_msgs = [m for m in history if m["role"] == "system"]
    assert len(system_msgs) == 2
    assert "KYC Verification → Account Restriction" in system_msgs[0]["content"]
    assert "Account Restriction → Fraud & Security" in system_msgs[1]["content"]
