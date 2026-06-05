"""
wait_for_trigger node — pauses execution until an external HTTP trigger.

Currently supports: email_verification (GET /email/verify/{token}).
Creates a signed verification token and sets waiting_for to
"external_trigger:{token}" on the execution.
"""
from __future__ import annotations
import uuid
import logging
from workflow_engine.models import WorkflowNode, ExecutionContext, NodeResult

logger = logging.getLogger(__name__)


def create_verification_token(ticket_id: str, from_email: str) -> str:
    from db.email_store import create_verification_token as _fn
    return _fn(ticket_id=ticket_id, from_email=from_email)


class WaitForTriggerNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        trigger_type = node.config.get("trigger_type", "email_verification")

        token = ""
        if trigger_type == "email_verification" and not ctx.dry_run:
            ticket_id  = ctx.variables.get("ticket_id", ctx.conversation_id)
            from_email = ctx.variables.get("from_email", "")
            token = create_verification_token(
                ticket_id=ticket_id,
                from_email=from_email,
            )
        elif ctx.dry_run:
            token = f"dry-run-token-{uuid.uuid4().hex[:8]}"

        waiting_for = f"external_trigger:{token}" if token else "external_trigger:"
        logger.info("wait_for_trigger_paused", extra={
            "node_id": node.id, "conv_id": ctx.conversation_id,
            "trigger_type": trigger_type, "dry_run": ctx.dry_run,
        })

        return NodeResult(
            output={"trigger_type": trigger_type, "token": token},
            next_node_id=node.next_node_id,
            pause=True,
            waiting_for=waiting_for,
        )
