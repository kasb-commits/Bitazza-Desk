"""
escalate node — escalates ticket to human agent.

Status written to DB:
  widget → "pending_human"
  email  → "Escalated"

In dry-run mode, DB write is skipped but output still signals escalation.
"""
from __future__ import annotations
import logging
from workflow_engine.models import WorkflowNode, ExecutionContext, NodeResult

logger = logging.getLogger(__name__)


def get_ticket_id_by_conversation(conversation_id: str) -> str | None:
    from db.conversation_store import get_ticket_id_by_conversation as _fn
    return _fn(conversation_id)


def update_ticket_status(ticket_id: str, status: str) -> None:
    from db.conversation_store import update_ticket_status as _fn
    _fn(ticket_id, status)


def get_ticket_meta(ticket_id: str) -> dict:
    from db.conversation_store import get_ticket_meta as _fn
    return _fn(ticket_id)


def trigger_auto_assign(ticket_id, category, priority, customer_id) -> None:
    from engine.assignment_client import trigger_auto_assign as _fn
    _fn(ticket_id, category, priority, customer_id)


class EscalateNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        channel  = ctx.variables.get("channel", ctx.channel)
        category = ctx.variables.get("category")
        language = ctx.variables.get("language", "en")
        status   = "Escalated" if channel == "email" else "pending_human"

        if not ctx.dry_run:
            ticket_id = get_ticket_id_by_conversation(ctx.conversation_id)
            if ticket_id:
                update_ticket_status(ticket_id, status)
                _meta = get_ticket_meta(ticket_id)
                if _meta.get("customer_id"):
                    trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))

        # Build specialist handoff message.
        # If the ai_reply node already generated an explanation (e.g. "your account is
        # frozen because X — a specialist will review"), preserve it and append the
        # handoff so customers see both the explanation and the transition message.
        from engine.prompt_templates import build_handoff_message
        handoff     = build_handoff_message(category, language)
        prior_reply = ctx.variables.get("reply", "").strip()
        reply       = f"{prior_reply}\n\n{handoff}" if len(prior_reply) > 20 else handoff

        logger.info("escalation_node_triggered", extra={
            "node_id": node.id, "conv_id": ctx.conversation_id,
            "channel": channel, "category": category,
            "status": status, "team": node.config.get("team", "cs"),
            "dry_run": ctx.dry_run,
        })
        return NodeResult(
            output={
                "reply":           reply,
                "escalated":       True,
                "escalated_final": True,   # Tells engine to set execution.escalated
                "status":          status,
                "team":            node.config.get("team", "cs"),
                "reason":          node.config.get("reason", "workflow_escalation"),
            },
            next_node_id=node.next_node_id,
        )
