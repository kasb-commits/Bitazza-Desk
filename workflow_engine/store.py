"""
Workflow engine DB store.

All functions accept an optional `conn` parameter for testability (SQLite in tests,
real psycopg2 connection in production via get_connection()).

Tables: workflows, workflow_executions (see migration 007).
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


def get_connection():
    """Return a live PostgreSQL connection (RealDictCursor)."""
    import psycopg2
    import psycopg2.extras
    from config import settings
    return psycopg2.connect(settings.DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


# ── Internal deserializers ────────────────────────────────────────────────────

def _row_to_workflow(row) -> "Workflow":
    from workflow_engine.models import Workflow, WorkflowTrigger, WorkflowNode
    nodes_raw = json.loads(row["nodes_json"]) if isinstance(row["nodes_json"], str) else (row["nodes_json"] or [])
    edges_raw = json.loads(row["edges_json"]) if isinstance(row["edges_json"], str) else (row["edges_json"] or [])

    # Derive next_node_id, condition branches, and error branch from edges
    next_map: dict = {}
    true_map: dict = {}
    false_map: dict = {}
    error_map: dict = {}
    for edge in edges_raw:
        src = edge.get("source")
        tgt = edge.get("target")
        handle = edge.get("sourceHandle")
        if handle == "true":
            true_map[src] = tgt
        elif handle == "false":
            false_map[src] = tgt
        elif handle == "error":
            error_map[src] = tgt
        else:
            next_map[src] = tgt

    nodes = []
    for n in nodes_raw:
        # Accept both canvas format (type/data) and execution format (kind/config)
        kind   = n.get("kind") or n.get("type", "")
        config = dict(n.get("config") or n.get("data") or {})

        if kind == "condition":
            config.setdefault("true_next",  true_map.get(n["id"]))
            config.setdefault("false_next", false_map.get(n["id"]))

        next_node_id     = n.get("next_node_id") or next_map.get(n["id"])
        on_error_next_id = n.get("on_error_next_id") or error_map.get(n["id"])
        nodes.append(WorkflowNode(
            id=n["id"], kind=kind, config=config,
            next_node_id=next_node_id, on_error_next_id=on_error_next_id,
        ))

    return Workflow(
        id=row["id"],
        name=row["name"],
        trigger=WorkflowTrigger(
            channel=row["trigger_channel"],
            category=row["trigger_category"],
        ),
        nodes=nodes,
        edges=edges_raw,
        published=bool(row["published"]),
        version=row["version"],
    )


def _row_to_execution(row) -> "WorkflowExecution":
    from workflow_engine.models import WorkflowExecution, ExecutionStatus
    variables = json.loads(row["variables_json"]) if isinstance(row["variables_json"], str) else row["variables_json"]
    return WorkflowExecution(
        id=row["id"],
        workflow_id=row["workflow_id"],
        conversation_id=row["conversation_id"],
        current_node_id=row["current_node_id"],
        variables=variables,
        status=ExecutionStatus(row["status"]),
        waiting_for=row["waiting_for"],
        channel=row["channel"],
        category=row["category"],
    )


# ── Workflow queries ──────────────────────────────────────────────────────────

def load_workflow_by_id(workflow_id: str, conn=None) -> "Workflow | None":
    c = conn or get_connection()
    try:
        cur = c.execute(
            "SELECT * FROM workflows WHERE id = ?", (workflow_id,)
        ) if hasattr(c, "execute") else None

        if cur is None:
            # psycopg2 path
            with c.cursor() as cur:
                cur.execute("SELECT * FROM workflows WHERE id = %s", (workflow_id,))
                row = cur.fetchone()
        else:
            row = cur.fetchone()

        if not row:
            return None
        return _row_to_workflow(dict(row))
    except Exception:
        logger.exception("load_workflow_by_id failed for %s", workflow_id)
        return None


def get_published_workflows(conn=None) -> list["Workflow"]:
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            rows = c.execute("SELECT * FROM workflows WHERE published = 1").fetchall()
        else:
            with c.cursor() as cur:
                cur.execute("SELECT * FROM workflows WHERE published = TRUE")
                rows = cur.fetchall()
        return [_row_to_workflow(dict(r)) for r in rows]
    except Exception:
        logger.exception("get_published_workflows failed")
        return []


def get_published_workflows_by_trigger(channel: str, category: str, conn=None) -> list["Workflow"]:
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            rows = c.execute("""
                SELECT * FROM workflows
                WHERE published = 1
                  AND (trigger_channel = ? OR trigger_channel = 'any')
                  AND (trigger_category = ? OR trigger_category = 'any')
            """, (channel, category)).fetchall()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT * FROM workflows
                    WHERE published = TRUE
                      AND (trigger_channel = %s OR trigger_channel = 'any')
                      AND (trigger_category = %s OR trigger_category = 'any')
                """, (channel, category))
                rows = cur.fetchall()
        return [_row_to_workflow(dict(r)) for r in rows]
    except Exception:
        logger.exception("get_published_workflows_by_trigger failed")
        return []


# ── Execution queries ─────────────────────────────────────────────────────────

def create_execution(
    execution_id: str,
    workflow_id: str,
    conversation_id: str,
    current_node_id: str | None,
    variables: dict,
    status: "ExecutionStatus",
    channel: str,
    category: str,
    conn=None,
) -> None:
    c = conn or get_connection()
    variables_json = json.dumps(variables)
    try:
        if hasattr(c, "execute"):
            c.execute("""
                INSERT INTO workflow_executions
                (id, workflow_id, conversation_id, current_node_id,
                 variables_json, status, channel, category)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (execution_id, workflow_id, conversation_id, current_node_id,
                  variables_json, status.value, channel, category))
            c.commit()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    INSERT INTO workflow_executions
                    (id, workflow_id, conversation_id, current_node_id,
                     variables_json, status, channel, category)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (execution_id, workflow_id, conversation_id, current_node_id,
                      variables_json, status.value, channel, category))
            c.commit()
    except Exception:
        logger.exception("create_execution failed for %s", execution_id)
        raise


def load_execution(execution_id: str, conn=None) -> "WorkflowExecution | None":
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            row = c.execute(
                "SELECT * FROM workflow_executions WHERE id = ?", (execution_id,)
            ).fetchone()
        else:
            with c.cursor() as cur:
                cur.execute("SELECT * FROM workflow_executions WHERE id = %s", (execution_id,))
                row = cur.fetchone()
        return _row_to_execution(dict(row)) if row else None
    except Exception:
        logger.exception("load_execution failed for %s", execution_id)
        return None


def update_execution_status(
    execution_id: str,
    status: "ExecutionStatus",
    current_node_id: str | None = None,
    waiting_for: str | None = None,
    variables: dict | None = None,
    output_reply: str | None = None,
    conn=None,
) -> None:
    c = conn or get_connection()
    variables_json = json.dumps(variables) if variables is not None else None
    try:
        if hasattr(c, "execute"):
            cur = c.execute("""
                UPDATE workflow_executions
                SET status = ?,
                    current_node_id = COALESCE(?, current_node_id),
                    waiting_for = ?,
                    variables_json = COALESCE(?, variables_json),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (status.value, current_node_id, waiting_for,
                  variables_json, execution_id))
            if cur.rowcount == 0:
                raise LookupError(f"No execution row with id {execution_id}")
            c.commit()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    UPDATE workflow_executions
                    SET status = %s,
                        current_node_id = COALESCE(%s, current_node_id),
                        waiting_for = %s,
                        variables_json = COALESCE(%s::jsonb, variables_json),
                        updated_at = NOW()
                    WHERE id = %s
                """, (status.value, current_node_id, waiting_for,
                      variables_json, execution_id))
                if cur.rowcount == 0:
                    raise LookupError(f"No execution row with id {execution_id}")
            c.commit()
    except LookupError:
        raise
    except Exception:
        logger.exception("update_execution_status failed for %s", execution_id)
        raise


def get_active_execution(conversation_id: str, conn=None) -> "WorkflowExecution | None":
    """Return the most recent non-terminal execution for a conversation."""
    from workflow_engine.models import ExecutionStatus
    terminal = (ExecutionStatus.COMPLETED.value, ExecutionStatus.FAILED.value,
                ExecutionStatus.ABANDONED.value)
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            placeholders = ",".join("?" * len(terminal))
            row = c.execute(f"""
                SELECT * FROM workflow_executions
                WHERE conversation_id = ?
                  AND status NOT IN ({placeholders})
                ORDER BY created_at DESC LIMIT 1
            """, (conversation_id, *terminal)).fetchone()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT * FROM workflow_executions
                    WHERE conversation_id = %s
                      AND status NOT IN %s
                    ORDER BY created_at DESC LIMIT 1
                """, (conversation_id, terminal))
                row = cur.fetchone()
        return _row_to_execution(dict(row)) if row else None
    except Exception:
        logger.exception("get_active_execution failed for %s", conversation_id)
        return None


def abandon_active_execution(conversation_id: str, conn=None) -> None:
    """Mark any non-terminal execution for this conversation as ABANDONED.
    Called when the user switches issue category mid-conversation so the next
    message starts a fresh workflow instead of resuming the old one.
    """
    from workflow_engine.models import ExecutionStatus
    active = get_active_execution(conversation_id, conn=conn)
    if active is None:
        return
    try:
        update_execution_status(
            execution_id=active.id,
            status=ExecutionStatus.ABANDONED,
        )
        logger.info(
            "abandon_active_execution: abandoned %s for conversation %s",
            active.id, conversation_id,
        )
    except Exception:
        logger.exception("abandon_active_execution failed for %s", conversation_id)


def set_execution_trigger_token(execution_id: str, token: str, conn=None) -> None:
    c = conn or get_connection()
    waiting_for = f"external_trigger:{token}"
    try:
        if hasattr(c, "execute"):
            c.execute(
                "UPDATE workflow_executions SET waiting_for = ? WHERE id = ?",
                (waiting_for, execution_id)
            )
            c.commit()
        else:
            with c.cursor() as cur:
                cur.execute(
                    "UPDATE workflow_executions SET waiting_for = %s WHERE id = %s",
                    (waiting_for, execution_id)
                )
            c.commit()
    except Exception:
        logger.exception("set_execution_trigger_token failed for %s", execution_id)
        raise


def load_execution_by_trigger_token(token: str, conn=None):
    """Return (WorkflowExecution, Workflow) or None if token not found."""
    waiting_for = f"external_trigger:{token}"
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            row = c.execute("""
                SELECT * FROM workflow_executions WHERE waiting_for = ?
            """, (waiting_for,)).fetchone()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT * FROM workflow_executions WHERE waiting_for = %s
                """, (waiting_for,))
                row = cur.fetchone()

        if not row:
            return None

        execution = _row_to_execution(dict(row))
        workflow = load_workflow_by_id(execution.workflow_id, conn=conn)
        return (execution, workflow)
    except Exception:
        logger.exception("load_execution_by_trigger_token failed for token %s", token)
        return None


def is_workflow_active(ticket_id: str, conn=None) -> bool:
    """Return True if the ticket has a non-terminal workflow execution."""
    from workflow_engine.models import ExecutionStatus
    terminal = (ExecutionStatus.COMPLETED.value, ExecutionStatus.FAILED.value,
                ExecutionStatus.ABANDONED.value)
    c = conn or get_connection()
    try:
        if hasattr(c, "execute"):
            placeholders = ",".join("?" * len(terminal))
            row = c.execute(f"""
                SELECT we.id FROM workflow_executions we
                JOIN tickets t ON t.id = ?
                WHERE we.conversation_id IN (
                    SELECT id FROM tickets WHERE id = ?
                )
                AND we.status NOT IN ({placeholders})
                LIMIT 1
            """, (ticket_id, ticket_id, *terminal)).fetchone()
        else:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT we.id FROM workflow_executions we
                    WHERE we.conversation_id = %s
                      AND we.status NOT IN %s
                    LIMIT 1
                """, (ticket_id, terminal))
                row = cur.fetchone()
        return row is not None
    except Exception:
        logger.exception("is_workflow_active failed for ticket %s", ticket_id)
        # Fail-open: don't block auto-transitions if guard crashes
        raise
