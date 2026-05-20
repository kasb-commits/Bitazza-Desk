"""
Integration tests for workflow DB layer (workflow_engine.store).

Uses in-memory SQLite to mirror the PostgreSQL schema.
Tests: create workflow, publish, load by trigger, create/update execution,
       load active execution, auto-transition guard, trigger token lookup.
"""
import pytest
import sqlite3
import uuid
from contextlib import contextmanager
from unittest.mock import patch


# ── SQLite schema mirror ───────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger_channel TEXT NOT NULL DEFAULT 'any',
    trigger_category TEXT NOT NULL DEFAULT 'any',
    nodes_json TEXT NOT NULL DEFAULT '[]',
    edges_json TEXT NOT NULL DEFAULT '[]',
    published INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    current_node_id TEXT,
    variables_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'running',
    waiting_for TEXT,
    channel TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    workflow_active INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Open_Live',
    channel TEXT DEFAULT 'web'
);
"""


@pytest.fixture
def sqlite_conn():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


@contextmanager
def _patch_db(conn):
    """Patch workflow store to use the SQLite connection."""
    with patch("workflow_engine.store.get_connection", return_value=conn):
        yield


# ── Workflow CRUD ─────────────────────────────────────────────────────────────

class TestWorkflowStoreCRUD:

    def test_save_and_load_workflow(self, sqlite_conn):
        import json
        with _patch_db(sqlite_conn):
            from workflow_engine.store import load_workflow_by_id

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (wf_id, "KYC Flow", "widget", "kyc_verification", "[]", "[]", 0, 1))
            sqlite_conn.commit()

            workflow = load_workflow_by_id(wf_id, conn=sqlite_conn)

        assert workflow is not None
        assert workflow.id == wf_id
        assert workflow.name == "KYC Flow"
        assert workflow.trigger.channel == "widget"
        assert workflow.trigger.category == "kyc_verification"

    def test_load_nonexistent_workflow_returns_none(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import load_workflow_by_id
            result = load_workflow_by_id("does-not-exist", conn=sqlite_conn)
        assert result is None

    def test_get_published_workflows_returns_only_published(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import get_published_workflows

            sqlite_conn.executemany("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, [
                (str(uuid.uuid4()), "Published", "widget", "kyc_verification", "[]", "[]", 1, 1),
                (str(uuid.uuid4()), "Draft", "widget", "withdrawal_issue", "[]", "[]", 0, 1),
                (str(uuid.uuid4()), "Also Published", "email", "kyc_verification", "[]", "[]", 1, 1),
            ])
            sqlite_conn.commit()

            workflows = get_published_workflows(conn=sqlite_conn)

        assert len(workflows) == 2
        assert all(w.published for w in workflows)

    def test_get_published_workflows_by_trigger(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import get_published_workflows_by_trigger

            sqlite_conn.executemany("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, [
                (str(uuid.uuid4()), "KYC Widget", "widget", "kyc_verification", "[]", "[]", 1, 1),
                (str(uuid.uuid4()), "KYC Email", "email", "kyc_verification", "[]", "[]", 1, 1),
                (str(uuid.uuid4()), "Withdrawal Widget", "widget", "withdrawal_issue", "[]", "[]", 1, 1),
            ])
            sqlite_conn.commit()

            results = get_published_workflows_by_trigger(
                channel="widget", category="kyc_verification", conn=sqlite_conn
            )

        assert len(results) == 1
        assert results[0].trigger.channel == "widget"
        assert results[0].trigger.category == "kyc_verification"


# ── Execution store ───────────────────────────────────────────────────────────

class TestExecutionStore:

    def test_create_and_load_execution(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import create_execution, load_execution
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'widget', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            exec_id = str(uuid.uuid4())
            create_execution(
                execution_id=exec_id,
                workflow_id=wf_id,
                conversation_id="conv-1",
                current_node_id="n1",
                variables={"language": "en"},
                status=ExecutionStatus.RUNNING,
                channel="widget",
                category="kyc_verification",
                conn=sqlite_conn,
            )

            execution = load_execution(exec_id, conn=sqlite_conn)

        assert execution is not None
        assert execution.id == exec_id
        assert execution.conversation_id == "conv-1"
        assert execution.variables["language"] == "en"

    def test_update_execution_status(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import create_execution, update_execution_status, load_execution
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'widget', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            exec_id = str(uuid.uuid4())
            create_execution(
                execution_id=exec_id, workflow_id=wf_id, conversation_id="conv-1",
                current_node_id="n1", variables={},
                status=ExecutionStatus.RUNNING, channel="widget",
                category="kyc_verification", conn=sqlite_conn,
            )

            update_execution_status(
                exec_id, ExecutionStatus.WAITING_MESSAGE,
                current_node_id="n2",
                waiting_for="message",
                conn=sqlite_conn,
            )

            execution = load_execution(exec_id, conn=sqlite_conn)

        assert execution.status == ExecutionStatus.WAITING_MESSAGE
        assert execution.current_node_id == "n2"
        assert execution.waiting_for == "message"

    def test_get_active_execution_for_conversation(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import create_execution, get_active_execution
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'widget', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            exec_id = str(uuid.uuid4())
            create_execution(
                execution_id=exec_id, workflow_id=wf_id,
                conversation_id="conv-unique-1",
                current_node_id="n2", variables={},
                status=ExecutionStatus.WAITING_MESSAGE,
                channel="widget", category="kyc_verification",
                conn=sqlite_conn,
            )

            active = get_active_execution("conv-unique-1", conn=sqlite_conn)

        assert active is not None
        assert active.id == exec_id

    def test_get_active_execution_returns_none_for_completed(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import create_execution, update_execution_status, get_active_execution
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'widget', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            exec_id = str(uuid.uuid4())
            create_execution(
                execution_id=exec_id, workflow_id=wf_id,
                conversation_id="conv-done-1",
                current_node_id="n1", variables={},
                status=ExecutionStatus.COMPLETED,
                channel="widget", category="kyc_verification",
                conn=sqlite_conn,
            )

            active = get_active_execution("conv-done-1", conn=sqlite_conn)

        assert active is None

    def test_load_execution_by_trigger_token(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import (
                create_execution, set_execution_trigger_token,
                load_execution_by_trigger_token,
            )
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'email', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            exec_id = str(uuid.uuid4())
            create_execution(
                execution_id=exec_id, workflow_id=wf_id,
                conversation_id="conv-email-1",
                current_node_id="n3", variables={},
                status=ExecutionStatus.WAITING_TRIGGER,
                channel="email", category="kyc_verification",
                conn=sqlite_conn,
            )
            set_execution_trigger_token(exec_id, "tok-abc123", conn=sqlite_conn)

            result = load_execution_by_trigger_token("tok-abc123", conn=sqlite_conn)

        assert result is not None
        execution, _ = result
        assert execution.id == exec_id

    def test_expired_token_returns_none(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import load_execution_by_trigger_token
            result = load_execution_by_trigger_token("nonexistent-token", conn=sqlite_conn)
        assert result is None


# ── Auto-transition guard ─────────────────────────────────────────────────────

class TestAutoTransitionGuard:

    def test_is_workflow_active_true_when_execution_running(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import create_execution, is_workflow_active
            from workflow_engine.models import ExecutionStatus

            wf_id = str(uuid.uuid4())
            sqlite_conn.execute("""
                INSERT INTO workflows (id, name, trigger_channel, trigger_category,
                                       nodes_json, edges_json, published, version)
                VALUES (?, 'W', 'widget', 'kyc_verification', '[]', '[]', 1, 1)
            """, (wf_id,))
            sqlite_conn.commit()

            # In this system conversation_id == ticket_id
            create_execution(
                execution_id=str(uuid.uuid4()), workflow_id=wf_id,
                conversation_id="ticket-active-1",
                current_node_id="n1", variables={},
                status=ExecutionStatus.RUNNING,
                channel="widget", category="kyc_verification",
                conn=sqlite_conn,
            )

            # Create ticket
            sqlite_conn.execute(
                "INSERT INTO tickets (id, workflow_active) VALUES ('ticket-active-1', 1)"
            )
            sqlite_conn.commit()

            active = is_workflow_active("ticket-active-1", conn=sqlite_conn)

        assert active is True

    def test_is_workflow_active_false_when_no_execution(self, sqlite_conn):
        with _patch_db(sqlite_conn):
            from workflow_engine.store import is_workflow_active

            sqlite_conn.execute(
                "INSERT INTO tickets (id, workflow_active) VALUES ('ticket-idle-1', 0)"
            )
            sqlite_conn.commit()

            active = is_workflow_active("ticket-idle-1", conn=sqlite_conn)

        assert active is False
