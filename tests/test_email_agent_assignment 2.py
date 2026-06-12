"""
Tests for email-channel mock-agent assignment.

Coverage:
  - engine.mock_agents: pick_agent() maps every category to the correct named agent
  - db.conversation_store: assign_ai_persona() persists agent fields; get_ai_persona() retrieves them
  - api.routes.email._process_inbound_email (new ticket):
      * pick_agent() called with detected category
      * assign_ai_persona() called with the picked agent's fields
      * new_ticket WS broadcast sends a { ticket: Ticket } object with ai_persona set
      * assistant add_message metadata carries agent_name / agent_avatar / agent_avatar_url
      * new_message WS broadcast carries agent_name / agent_avatar / agent_avatar_url
  - api.routes.email._process_inbound_email (existing ticket / follow-up):
      * assign_ai_persona() NOT called again
      * get_ai_persona() IS called to load existing assignment
      * reply metadata and broadcast still carry agent fields from stored persona
"""

import json
import sqlite3
import uuid
from contextlib import contextmanager, ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from engine.email_parser import ParsedEmail
from engine.mock_agents import AGENTS, CATEGORY_AGENT_MAP


# ── SQLite adapter ────────────────────────────────────────────────────────────

def _make_sqlite_conn():
    conn = sqlite3.connect(":memory:", detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            name TEXT,
            email TEXT UNIQUE,
            external_id TEXT
        );

        CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            customer_id TEXT,
            channel TEXT DEFAULT 'email',
            status TEXT DEFAULT 'Open_Live',
            category TEXT,
            priority INTEGER DEFAULT 3,
            team TEXT DEFAULT 'cs',
            assigned_to TEXT,
            ai_persona TEXT,
            gmail_thread_id TEXT,
            subject TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            ticket_id TEXT,
            sender_type TEXT,
            content TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS email_threads (
            id TEXT PRIMARY KEY,
            ticket_id TEXT,
            gmail_thread_id TEXT,
            gmail_message_id TEXT UNIQUE,
            direction TEXT,
            from_email TEXT,
            from_name TEXT,
            subject TEXT,
            snippet TEXT,
            attachments TEXT DEFAULT '[]',
            raw_headers TEXT DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    return conn


class _FakeCursor:
    def __init__(self, sqlite_conn):
        self._cur = sqlite_conn.cursor()
        self.rowcount = 0

    def _translate(self, sql: str) -> str:
        import re
        sql = sql.replace("%s", "?")
        sql = re.sub(r"::\w+", "", sql)
        sql = re.sub(r"gen_random_uuid\(\)", "lower(hex(randomblob(16)))", sql)
        sql = re.sub(r"NOW\(\)", "CURRENT_TIMESTAMP", sql)
        sql = re.sub(
            r"INSERT\s+INTO\s+(\S+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON CONFLICT.*",
            lambda m: f"INSERT OR REPLACE INTO {m.group(1)} ({m.group(2)}) VALUES ({m.group(3)})",
            sql,
            flags=re.DOTALL | re.IGNORECASE,
        )
        sql = re.sub(r"ON CONFLICT[^;]*DO NOTHING", "", sql, flags=re.DOTALL | re.IGNORECASE)
        return sql

    def execute(self, sql: str, params=()):
        translated = self._translate(sql)
        if params:
            params = tuple(
                json.dumps(p) if isinstance(p, (dict, list)) else p
                for p in params
            )
        self._cur.execute(translated, params)
        self.rowcount = self._cur.rowcount

    def fetchone(self):
        row = self._cur.fetchone()
        if row is None:
            return None
        return _RowAdapter(row, self._cur.description)

    def fetchall(self):
        return [_RowAdapter(r, self._cur.description) for r in self._cur.fetchall()]


class _RowAdapter:
    def __init__(self, row, description):
        keys = [d[0] for d in description] if description else []
        self._data = dict(zip(keys, row))

    def __getitem__(self, key):
        v = self._data[key]
        # SQLite stores JSONB columns as plain strings; parse them back to dicts/lists
        # so that code which does row["ai_persona"].get(...) works the same as PostgreSQL.
        if isinstance(v, str) and (v.startswith("{") or v.startswith("[")):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                pass
        return v

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key):
        return key in self._data


class _FakeConn:
    def __init__(self, sqlite_conn):
        self._conn = sqlite_conn

    def cursor(self):
        return _FakeCursor(self._conn)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        pass


@pytest.fixture()
def sqlite_db():
    return _make_sqlite_conn()


@pytest.fixture(autouse=True)
def mock_db(sqlite_db, monkeypatch):
    fake_conn = _FakeConn(sqlite_db)

    @contextmanager
    def _fake_conn_ctx():
        yield fake_conn

    import db.conversation_store as store
    import db.email_store as estore
    import api.routes.email as email_route
    monkeypatch.setattr(store, "_conn", _fake_conn_ctx)
    monkeypatch.setattr(store, "_fetch_user_profile", lambda uid: {})
    # Prevent try_claim_gmail_message from writing to the real PostgreSQL DB.
    # Without this patch, static test message IDs get claimed on first run and
    # _process_inbound_email returns early on every subsequent run.
    monkeypatch.setattr(email_route, "try_claim_gmail_message", lambda _: True)


# ── Shared helpers ────────────────────────────────────────────────────────────

def _insert_ticket(sqlite_db, category=None, gmail_thread_id=None, ai_persona=None) -> str:
    tid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    sqlite_db.execute(
        "INSERT INTO customers (id, name, email) VALUES (?, ?, ?)",
        (cid, "Test User", f"{uuid.uuid4()}@example.com"),
    )
    persona_json = json.dumps(ai_persona) if ai_persona else None
    sqlite_db.execute(
        """INSERT INTO tickets (id, customer_id, channel, category, gmail_thread_id, ai_persona)
           VALUES (?, ?, 'email', ?, ?, ?)""",
        (tid, cid, category, gmail_thread_id, persona_json),
    )
    sqlite_db.commit()
    return tid


def _make_parsed_email(**kwargs) -> ParsedEmail:
    defaults = dict(
        message_id="<msg-001@gmail.com>",
        thread_id="thread-001",
        from_email="customer@example.com",
        from_name="Customer",
        subject="I need help with KYC",
        body="My KYC verification was rejected.",
        snippet="My KYC verification was rejected.",
        language="en",
        attachments=[],
        raw_headers={},
        in_reply_to="",
        references="",
    )
    defaults.update(kwargs)
    return ParsedEmail(**defaults)


def _make_agent_response(text="Here to help.", confidence=0.9, escalated=False, resolved=False):
    r = MagicMock()
    r.text = text
    r.confidence = confidence
    r.escalated = escalated
    r.resolved = resolved
    return r


def _base_new_ticket_patches(category="kyc_verification", ticket_id="ticket-new-001"):
    """Common patches for a new-ticket inbound email flow."""
    parsed = _make_parsed_email()
    return {
        "api.routes.email.email_message_already_processed": MagicMock(return_value=False),
        "api.routes.email._get_gmail_service": MagicMock(),
        "api.routes.email.parse_gmail_message": MagicMock(return_value=parsed),
        "api.routes.email.get_ticket_by_gmail_thread": MagicMock(return_value=None),
        "api.routes.email.get_or_create_customer_by_email": MagicMock(return_value=("cust-001", True)),
        "api.routes.email.detect_category_from_message": MagicMock(return_value=category),
        "api.routes.email.create_email_ticket": MagicMock(return_value=ticket_id),
        "api.routes.email.requires_registered_email": MagicMock(return_value=False),
        "api.routes.email.requires_verification_link": MagicMock(return_value=False),
        "api.routes.email._resolve_user_id": MagicMock(return_value="user-001"),
        "api.routes.email._count_consecutive_low_confidence": MagicMock(return_value=0),
        "api.routes.email._download_and_store_attachments": MagicMock(return_value=[]),
        "api.routes.email.get_rejected_attachment_notice": MagicMock(return_value=""),
        "api.routes.email.log_email_message": MagicMock(),
        "api.routes.email._log_outbound": MagicMock(),
        "api.routes.email.create_csat_tokens": MagicMock(return_value=None),
        "api.routes.email.add_message": MagicMock(return_value="msg-001"),
        "api.routes.email.update_ticket_status": MagicMock(),
    }


def _base_existing_ticket_patches(existing_ticket_id="ticket-existing-001"):
    """Common patches for a follow-up inbound email flow."""
    parsed = _make_parsed_email()
    return {
        "api.routes.email.email_message_already_processed": MagicMock(return_value=False),
        "api.routes.email._get_gmail_service": MagicMock(),
        "api.routes.email.parse_gmail_message": MagicMock(return_value=parsed),
        "api.routes.email.get_ticket_by_gmail_thread": MagicMock(return_value=existing_ticket_id),
        "api.routes.email.get_or_create_customer_by_email": MagicMock(return_value=("cust-001", True)),
        "api.routes.email.detect_category_from_message": MagicMock(return_value="kyc_verification"),
        "api.routes.email.create_email_ticket": MagicMock(),  # should NOT be called
        "api.routes.email.update_ticket_status": MagicMock(),
        "api.routes.email.requires_registered_email": MagicMock(return_value=False),
        "api.routes.email.requires_verification_link": MagicMock(return_value=False),
        "api.routes.email._resolve_user_id": MagicMock(return_value="user-001"),
        "api.routes.email._count_consecutive_low_confidence": MagicMock(return_value=0),
        "api.routes.email._download_and_store_attachments": MagicMock(return_value=[]),
        "api.routes.email.get_rejected_attachment_notice": MagicMock(return_value=""),
        "api.routes.email.log_email_message": MagicMock(),
        "api.routes.email._log_outbound": MagicMock(),
        "api.routes.email.create_csat_tokens": MagicMock(return_value=None),
        "api.routes.email.add_message": MagicMock(return_value="msg-ex-001"),
    }


# ═════════════════════════════════════════════════════════════════════════════
# pick_agent — category → agent mapping
# ═════════════════════════════════════════════════════════════════════════════

class TestPickAgent:
    """pick_agent() returns the expected specialist for every known category."""

    @pytest.mark.parametrize("category,expected_name", [
        ("kyc_verification",    "Aria"),
        ("account_restriction", "Aria"),
        ("password_2fa_reset",  "Aria"),
        ("fraud_security",      "Aria"),
        ("withdrawal_issue",    "Aria"),
        ("other",               "Aria"),
    ])
    def test_category_maps_to_correct_agent(self, category, expected_name):
        from engine.mock_agents import pick_agent
        assert pick_agent(category)["name"] == expected_name

    def test_none_category_returns_a_valid_agent(self):
        from engine.mock_agents import pick_agent
        assert pick_agent(None) in AGENTS

    def test_unknown_category_returns_a_valid_agent(self):
        from engine.mock_agents import pick_agent
        assert pick_agent("not_a_real_category") in AGENTS

    def test_all_agents_in_map_exist_in_agents_list(self):
        agent_names = {a["name"] for a in AGENTS}
        for category, name in CATEGORY_AGENT_MAP.items():
            assert name in agent_names, f"{name} (mapped for {category}) not in AGENTS list"

    def test_returned_agent_has_required_fields(self):
        from engine.mock_agents import pick_agent
        agent = pick_agent("kyc_verification")
        assert "name" in agent
        assert "avatar" in agent
        assert "avatar_url" in agent


# ═════════════════════════════════════════════════════════════════════════════
# assign_ai_persona / get_ai_persona — DB layer
# ═════════════════════════════════════════════════════════════════════════════

class TestAssignAiPersona:
    """assign_ai_persona() persists; get_ai_persona() retrieves."""

    def test_assign_then_get_returns_correct_fields(self, sqlite_db):
        from db.conversation_store import assign_ai_persona, get_ai_persona
        tid = _insert_ticket(sqlite_db)
        assign_ai_persona(tid, "Aria", "A", "/brand/logo.png")
        persona = get_ai_persona(tid)
        assert persona["name"] == "Aria"
        assert persona["avatar"] == "A"
        assert persona["avatar_url"] == "/brand/logo.png"

    def test_get_ai_persona_returns_none_fields_when_unset(self, sqlite_db):
        from db.conversation_store import get_ai_persona
        tid = _insert_ticket(sqlite_db)
        persona = get_ai_persona(tid)
        assert persona["name"] is None
        assert persona["avatar"] is None
        assert persona["avatar_url"] is None

    def test_assign_overwrites_previous_persona(self, sqlite_db):
        from db.conversation_store import assign_ai_persona, get_ai_persona
        tid = _insert_ticket(sqlite_db)
        assign_ai_persona(tid, "Aria", "A", "/brand/logo.png")
        assign_ai_persona(tid, "Aria", "A", "/brand/logo.png")
        assert get_ai_persona(tid)["name"] == "Aria"

    @pytest.mark.parametrize("category,expected_name", [
        ("kyc_verification",    "Aria"),
        ("account_restriction", "Aria"),
        ("password_2fa_reset",  "Aria"),
        ("fraud_security",      "Aria"),
        ("withdrawal_issue",    "Aria"),
        ("other",               "Aria"),
    ])
    def test_assign_then_get_for_each_category_agent(self, sqlite_db, category, expected_name):
        from db.conversation_store import assign_ai_persona, get_ai_persona
        from engine.mock_agents import pick_agent
        tid = _insert_ticket(sqlite_db, category=category)
        agent = pick_agent(category)
        assign_ai_persona(tid, agent["name"], agent["avatar"], agent["avatar_url"])
        assert get_ai_persona(tid)["name"] == expected_name


# ═════════════════════════════════════════════════════════════════════════════
# _process_inbound_email — new ticket
# ═════════════════════════════════════════════════════════════════════════════

class TestProcessInboundEmailNewTicket:

    @pytest.mark.asyncio
    async def test_pick_agent_called_with_detected_category(self):
        patches = _base_new_ticket_patches(category="kyc_verification")
        agent = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            mocks = {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            mock_pick = stack.enter_context(patch("api.routes.email.pick_agent", return_value=agent))
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-001"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-001")

        mock_pick.assert_called_once_with("kyc_verification")

    @pytest.mark.asyncio
    async def test_assign_ai_persona_called_with_picked_agent_fields(self):
        patches = _base_new_ticket_patches(category="fraud_security", ticket_id="ticket-fraud-001")
        agent = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.pick_agent", return_value=agent))
            mock_assign = stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": "Aria", "avatar": "A", "avatar_url": agent["avatar_url"]}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-002"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-002")

        mock_assign.assert_called_once_with("ticket-fraud-001", "Aria", "A", agent["avatar_url"])

    @pytest.mark.asyncio
    async def test_new_ticket_broadcast_includes_agent_fields(self):
        patches = _base_new_ticket_patches(category="withdrawal_issue", ticket_id="ticket-w-001")
        agent = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.pick_agent", return_value=agent))
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": "Aria", "avatar": "A", "avatar_url": agent["avatar_url"]}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-003"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-003")

        payload = mock_manager.broadcast_all.call_args[0][0]
        assert payload["type"] == "new_ticket"
        ticket_obj = payload["ticket"]
        assert ticket_obj["id"] == "ticket-w-001"
        assert ticket_obj["channel"] == "email"
        assert ticket_obj["ai_persona"]["ai_name"] == "Aria"
        assert ticket_obj["ai_persona"]["ai_avatar"] == "A"
        assert ticket_obj["ai_persona"]["ai_avatar_url"] == agent["avatar_url"]

    @pytest.mark.asyncio
    async def test_assistant_message_metadata_includes_agent_fields(self):
        add_message_mock = MagicMock(return_value="msg-p-001")
        patches = _base_new_ticket_patches(category="password_2fa_reset", ticket_id="ticket-p-001")
        patches["api.routes.email.add_message"] = add_message_mock
        agent = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.pick_agent", return_value=agent))
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": "Aria", "avatar": "A", "avatar_url": agent["avatar_url"]}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-004"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-004")

        assistant_call = next(
            (c for c in add_message_mock.call_args_list if c[0][1] == "assistant"),
            None,
        )
        assert assistant_call is not None, "No add_message call with role='assistant'"
        # metadata is passed as a keyword argument: add_message(tid, role, content, metadata={...})
        metadata = assistant_call[1]["metadata"]
        assert metadata["agent_name"] == "Aria"
        assert metadata["agent_avatar"] == "A"
        assert metadata["agent_avatar_url"] == agent["avatar_url"]

    @pytest.mark.asyncio
    async def test_new_message_broadcast_includes_agent_fields(self):
        patches = _base_new_ticket_patches(category="account_restriction", ticket_id="ticket-a-001")
        agent = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.pick_agent", return_value=agent))
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": "Aria", "avatar": "A", "avatar_url": agent["avatar_url"]}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-005"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-005")

        bot_broadcast = next(
            (c[0][1] for c in mock_manager.broadcast.call_args_list
             if isinstance(c[0][1], dict) and c[0][1].get("sender_type") == "bot"),
            None,
        )
        assert bot_broadcast is not None, "No bot new_message broadcast found"
        assert bot_broadcast["agent_name"] == "Aria"
        assert bot_broadcast["agent_avatar"] == "A"
        assert bot_broadcast["agent_avatar_url"] == agent["avatar_url"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("category,expected_agent", [
        ("kyc_verification",    "Aria"),
        ("account_restriction", "Aria"),
        ("password_2fa_reset",  "Aria"),
        ("fraud_security",      "Aria"),
        ("withdrawal_issue",    "Aria"),
        ("other",               "Aria"),
    ])
    async def test_each_category_assigns_correct_agent(self, category, expected_agent):
        """End-to-end: detected category → correct agent persisted for all 6 categories."""
        from engine.mock_agents import pick_agent as real_pick_agent
        agent = real_pick_agent(category)
        patches = _base_new_ticket_patches(category=category, ticket_id=f"ticket-{category}")

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            mock_assign = stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value={"name": agent["name"], "avatar": agent["avatar"], "avatar_url": agent["avatar_url"]}))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-cat"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email(f"gmail-msg-{category}")

        assigned_name = mock_assign.call_args[0][1]
        assert assigned_name == expected_agent


# ═════════════════════════════════════════════════════════════════════════════
# _process_inbound_email — existing ticket (follow-up)
# ═════════════════════════════════════════════════════════════════════════════

class TestProcessInboundEmailExistingTicket:
    """
    On a follow-up email assign_ai_persona must NOT be called again;
    get_ai_persona must be used to load the stored persona.
    """

    @pytest.mark.asyncio
    async def test_assign_ai_persona_not_called_for_existing_ticket(self):
        patches = _base_existing_ticket_patches(existing_ticket_id="ticket-existing-001")
        stored_persona = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            mock_assign = stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            mock_pick = stack.enter_context(patch("api.routes.email.pick_agent"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value=stored_persona))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-ex-001"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-existing-001")

        mock_assign.assert_not_called()
        mock_pick.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_ai_persona_called_for_existing_ticket(self):
        patches = _base_existing_ticket_patches(existing_ticket_id="ticket-existing-002")
        stored_persona = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.pick_agent"))
            mock_get_persona = stack.enter_context(patch("api.routes.email.get_ai_persona", return_value=stored_persona))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-ex-002"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-existing-002")

        mock_get_persona.assert_called_once_with("ticket-existing-002")

    @pytest.mark.asyncio
    async def test_follow_up_reply_carries_stored_agent_in_metadata(self):
        add_message_mock = MagicMock(return_value="msg-ex-003")
        patches = _base_existing_ticket_patches(existing_ticket_id="ticket-existing-003")
        patches["api.routes.email.add_message"] = add_message_mock
        stored_persona = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.pick_agent"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value=stored_persona))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-ex-003"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-existing-003")

        assistant_call = next(
            (c for c in add_message_mock.call_args_list if c[0][1] == "assistant"),
            None,
        )
        assert assistant_call is not None
        metadata = assistant_call[1]["metadata"]
        assert metadata["agent_name"] == "Aria"
        assert metadata["agent_avatar"] == "A"
        assert metadata["agent_avatar_url"] == stored_persona["avatar_url"]

    @pytest.mark.asyncio
    async def test_follow_up_broadcast_carries_stored_agent(self):
        patches = _base_existing_ticket_patches(existing_ticket_id="ticket-existing-004")
        stored_persona = {"name": "Aria", "avatar": "A", "avatar_url": "/brand/logo.png"}

        with ExitStack() as stack:
            {k: stack.enter_context(patch(k, v)) for k, v in patches.items()}
            stack.enter_context(patch("api.routes.email.assign_ai_persona"))
            stack.enter_context(patch("api.routes.email.pick_agent"))
            stack.enter_context(patch("api.routes.email.get_ai_persona", return_value=stored_persona))
            stack.enter_context(patch("engine.agent.chat", return_value=_make_agent_response()))
            stack.enter_context(patch("engine.email_sender.send_reply", return_value="sent-ex-004"))
            mock_manager = stack.enter_context(patch("api.routes.email.manager"))
            mock_manager.broadcast_all = AsyncMock()
            mock_manager.broadcast = AsyncMock()

            from api.routes.email import _process_inbound_email
            await _process_inbound_email("gmail-msg-existing-004")

        bot_broadcast = next(
            (c[0][1] for c in mock_manager.broadcast.call_args_list
             if isinstance(c[0][1], dict) and c[0][1].get("sender_type") == "bot"),
            None,
        )
        assert bot_broadcast is not None
        assert bot_broadcast["agent_name"] == "Aria"
        assert bot_broadcast["agent_avatar"] == "A"
        assert bot_broadcast["agent_avatar_url"] == stored_persona["avatar_url"]
