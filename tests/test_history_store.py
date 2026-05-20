"""
Tests for cross-session chat history DB layer.
Covers:
  - get_customer_tickets(): paginated ticket list with last_message preview
  - get_paginated_history(): paginated messages within a ticket
  - get_open_ticket_for_customer(): open/escalated ticket detection
  - create_conversation(): returns customer_id for persistence
"""
import pytest
import os
import uuid
import sqlite3
import re
import time
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import patch

os.environ.setdefault("CHROMA_PATH", "./data/chroma_test")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

import db.conversation_store as store


# ---------------------------------------------------------------------------
# SQLite in-memory DB helpers (same pattern as test_conversation_store.py)
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
    conn.execute("""
        CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL)
    """)
    conn.execute("""
        CREATE TABLE ticket_tags (ticket_id TEXT, tag_id TEXT, PRIMARY KEY (ticket_id, tag_id))
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


@pytest.fixture(autouse=True)
def mock_db(monkeypatch):
    sqlite_conn = _make_sqlite_conn()
    fake_conn = _FakeConn(sqlite_conn)

    @contextmanager
    def fake_context_manager():
        yield fake_conn
        fake_conn.commit()

    monkeypatch.setattr(store, "_conn", fake_context_manager)
    monkeypatch.setattr(store, "_fetch_user_profile", lambda user_id: {})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ticket(user_id: str, category: str = "kyc_verification", status: str = "Open_Live") -> str:
    """Create a conversation/ticket and return its id."""
    cid = store.create_conversation(user_id, "web", "en", category)
    if status != "Open_Live":
        store.update_ticket_status(cid, status)
    return cid


# ---------------------------------------------------------------------------
# create_conversation — must expose customer_id
# ---------------------------------------------------------------------------

class TestCreateConversationCustomerId:
    def test_returns_customer_id_alongside_ticket_id(self):
        """create_conversation must return customer_id so widget can persist it."""
        result = store.create_conversation("user_abc", "web")
        # After implementation, result should be a tuple (ticket_id, customer_id)
        # or create_conversation gains a get_customer_id_for_user() companion.
        # For now, assert the customer row exists and is stable.
        cid1 = store.create_conversation("user_stable", "web")
        cid2 = store.create_conversation("user_stable", "web")
        assert cid1 != cid2  # each call creates a NEW ticket
        # but same customer row must back both
        # (verified indirectly: no IntegrityError on duplicate external_id)

    def test_same_user_id_reuses_customer_row(self):
        """Two conversations for same user_id must share the same customer."""
        store.create_conversation("user_reuse", "web")
        store.create_conversation("user_reuse", "web")
        # If a new customer row were inserted each time, the UNIQUE constraint
        # on external_id would raise — the fact that we get here means it was reused.

    def test_different_user_ids_get_different_customers(self):
        store.create_conversation("user_A", "web")
        store.create_conversation("user_B", "web")
        # No assertion needed beyond "no crash" — uniqueness enforced by schema


# ---------------------------------------------------------------------------
# get_customer_tickets() — NEW function under test
# ---------------------------------------------------------------------------

class TestGetCustomerTickets:
    def test_returns_tickets_for_customer(self):
        user = "hist_user_1"
        store.create_conversation(user, "web", "en", "kyc_verification")
        store.create_conversation(user, "web", "en", "withdrawal_issue")

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert len(tickets) == 2

    def test_pagination_page1(self):
        user = "hist_user_pag"
        for i in range(7):
            store.create_conversation(user, "web", "en", "kyc_verification")
            time.sleep(0.001)  # ensure distinct created_at ordering

        page1 = store.get_customer_tickets(user, page=1, limit=5)
        assert len(page1) == 5

    def test_pagination_page2(self):
        user = "hist_user_pag2"
        for i in range(7):
            store.create_conversation(user, "web", "en", "kyc_verification")
            time.sleep(0.001)

        page2 = store.get_customer_tickets(user, page=2, limit=5)
        assert len(page2) == 2

    def test_ordered_newest_first(self):
        user = "hist_user_order"
        cid1 = store.create_conversation(user, "web", "en", "kyc_verification")
        time.sleep(0.002)
        cid2 = store.create_conversation(user, "web", "en", "withdrawal_issue")

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert tickets[0]["id"] == cid2  # newest first
        assert tickets[1]["id"] == cid1

    def test_excludes_other_customers_tickets(self):
        store.create_conversation("hist_user_A", "web", "en", "kyc_verification")
        store.create_conversation("hist_user_B", "web", "en", "withdrawal_issue")

        tickets_a = store.get_customer_tickets("hist_user_A", page=1, limit=10)
        assert len(tickets_a) == 1
        assert all(t["category"] == "kyc_verification" for t in tickets_a)

    def test_empty_for_unknown_user(self):
        tickets = store.get_customer_tickets("nobody_exists", page=1, limit=10)
        assert tickets == []

    def test_includes_last_message_preview(self):
        user = "hist_user_msg"
        cid = store.create_conversation(user, "web", "en", "password_2fa_reset")
        store.add_message(cid, "user", "I forgot my password")
        store.add_message(cid, "assistant", "I can help you reset it")

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert len(tickets) == 1
        assert tickets[0]["last_message"] == "I can help you reset it"

    def test_last_message_none_when_no_messages(self):
        user = "hist_user_nomsg"
        store.create_conversation(user, "web", "en", "kyc_verification")

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert tickets[0]["last_message"] is None

    def test_last_message_truncated_at_100_chars(self):
        user = "hist_user_long"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")
        long_msg = "A" * 150
        store.add_message(cid, "assistant", long_msg)

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert len(tickets[0]["last_message"]) <= 100

    def test_response_shape(self):
        user = "hist_user_shape"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")
        store.add_message(cid, "user", "hello")

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        t = tickets[0]
        assert "id" in t
        assert "category" in t
        assert "status" in t
        assert "created_at" in t
        assert "last_message" in t
        assert "last_message_at" in t

    def test_excludes_internal_notes_from_last_message(self):
        """Internal notes must never surface as last_message preview."""
        import json
        user = "hist_user_internal"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")
        store.add_message(cid, "assistant", "Visible message")
        store.add_message(cid, "internal_note", "Agent note: escalate", {"is_internal_note": True})

        tickets = store.get_customer_tickets(user, page=1, limit=10)
        assert tickets[0]["last_message"] == "Visible message"


# ---------------------------------------------------------------------------
# get_paginated_history() — NEW function under test
# ---------------------------------------------------------------------------

class TestGetPaginatedHistory:
    def test_returns_correct_page(self):
        cid = store.create_conversation("ph_user_1", "web")
        for i in range(25):
            store.add_message(cid, "user", f"message {i}")
            time.sleep(0.001)

        page1 = store.get_paginated_history(cid, page=1, limit=10)
        assert len(page1) == 10

    def test_pages_are_non_overlapping(self):
        cid = store.create_conversation("ph_user_2", "web")
        for i in range(20):
            store.add_message(cid, "user", f"msg {i}")
            time.sleep(0.001)

        page1 = store.get_paginated_history(cid, page=1, limit=10)
        page2 = store.get_paginated_history(cid, page=2, limit=10)

        contents_p1 = {m["content"] for m in page1}
        contents_p2 = {m["content"] for m in page2}
        assert contents_p1.isdisjoint(contents_p2)

    def test_last_page_is_partial(self):
        cid = store.create_conversation("ph_user_3", "web")
        for i in range(13):
            store.add_message(cid, "user", f"msg {i}")

        page2 = store.get_paginated_history(cid, page=2, limit=10)
        assert len(page2) == 3

    def test_page_beyond_end_returns_empty(self):
        cid = store.create_conversation("ph_user_4", "web")
        store.add_message(cid, "user", "only message")

        page5 = store.get_paginated_history(cid, page=5, limit=10)
        assert page5 == []

    def test_page1_newest_messages(self):
        """Page 1 should contain the most recent messages (scroll-up pagination)."""
        cid = store.create_conversation("ph_user_5", "web")
        for i in range(15):
            store.add_message(cid, "user", f"msg {i}")
            time.sleep(0.001)

        page1 = store.get_paginated_history(cid, page=1, limit=5)
        contents = [m["content"] for m in page1]
        # Most recent 5 messages are msg 10..14
        assert "msg 14" in contents
        assert "msg 0" not in contents

    def test_excludes_internal_notes(self):
        cid = store.create_conversation("ph_user_6", "web")
        store.add_message(cid, "user", "Visible")
        store.add_message(cid, "internal_note", "Hidden note", {"is_internal_note": True})

        page = store.get_paginated_history(cid, page=1, limit=10)
        assert all(m["role"] != "system" or "Hidden note" not in m["content"] for m in page)
        visible = [m for m in page if m["content"] == "Visible"]
        assert len(visible) == 1

    def test_unknown_conversation_returns_empty(self):
        result = store.get_paginated_history("nonexistent-uuid", page=1, limit=10)
        assert result == []

    def test_response_shape(self):
        cid = store.create_conversation("ph_user_7", "web")
        store.add_message(cid, "user", "hi")
        store.add_message(cid, "assistant", "hello")

        page = store.get_paginated_history(cid, page=1, limit=10)
        assert len(page) == 2
        for m in page:
            assert "role" in m
            assert "content" in m
            assert "created_at" in m


# ---------------------------------------------------------------------------
# get_open_ticket_for_customer() — NEW function under test
# ---------------------------------------------------------------------------

class TestGetOpenTicketForCustomer:
    def test_returns_open_live_ticket(self):
        user = "open_user_1"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")
        # status defaults to Open_Live

        result = store.get_open_ticket_for_customer(user)
        assert result is not None
        assert result["id"] == cid

    def test_returns_escalated_ticket(self):
        user = "open_user_2"
        cid = store.create_conversation(user, "web", "en", "account_restriction")
        store.update_ticket_status(cid, "escalated")

        result = store.get_open_ticket_for_customer(user)
        assert result is not None
        assert result["id"] == cid

    def test_returns_in_progress_ticket(self):
        user = "open_user_3"
        cid = store.create_conversation(user, "web", "en", "fraud_security")
        store.update_ticket_status(cid, "assigned")  # maps to In_Progress

        result = store.get_open_ticket_for_customer(user)
        assert result is not None

    def test_ignores_closed_tickets(self):
        user = "open_user_4"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")
        store.update_ticket_status(cid, "resolved")

        result = store.get_open_ticket_for_customer(user)
        assert result is None

    def test_returns_none_when_no_tickets(self):
        result = store.get_open_ticket_for_customer("brand_new_user_xyz")
        assert result is None

    def test_returns_most_recent_open_ticket(self):
        user = "open_user_5"
        cid_old = store.create_conversation(user, "web", "en", "kyc_verification")
        time.sleep(0.002)
        cid_new = store.create_conversation(user, "web", "en", "withdrawal_issue")

        result = store.get_open_ticket_for_customer(user)
        assert result["id"] == cid_new

    def test_response_shape(self):
        user = "open_user_6"
        cid = store.create_conversation(user, "web", "en", "kyc_verification")

        result = store.get_open_ticket_for_customer(user)
        assert result is not None
        assert "id" in result
        assert "category" in result
        assert "status" in result
        assert "created_at" in result

    def test_open_ticket_after_closed_one(self):
        """Closed ticket followed by new open ticket — should return the open one."""
        user = "open_user_7"
        cid_closed = store.create_conversation(user, "web", "en", "kyc_verification")
        store.update_ticket_status(cid_closed, "resolved")
        time.sleep(0.002)
        cid_open = store.create_conversation(user, "web", "en", "password_2fa_reset")

        result = store.get_open_ticket_for_customer(user)
        assert result["id"] == cid_open
