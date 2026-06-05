"""
resolve_ticket node — marks ticket as Resolved and handles CSAT.

Widget: sets resolved=True in output (widget shows CSAT UI).
Email:  additionally calls create_csat_tokens() to embed star links in reply.

In dry-run mode, no DB writes.
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


def create_csat_tokens(ticket_id: str) -> list[str]:
    from db.email_store import create_csat_tokens as _fn
    return _fn(ticket_id)


class ResolveTicketNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        channel   = ctx.variables.get("channel", ctx.channel)
        csat_tokens: list[str] = []

        if not ctx.dry_run:
            ticket_id = get_ticket_id_by_conversation(ctx.conversation_id)
            if ticket_id:
                update_ticket_status(ticket_id, "Resolved")
                if channel == "email":
                    csat_tokens = create_csat_tokens(ticket_id)

        output: dict = {"resolved": True}
        if csat_tokens:
            output["csat_tokens"] = csat_tokens

        logger.info("ticket_resolved_by_node", extra={
            "node_id": node.id, "conv_id": ctx.conversation_id,
            "channel": channel, "dry_run": ctx.dry_run,
        })
        return NodeResult(
            output=output,
            next_node_id=node.next_node_id,
        )
