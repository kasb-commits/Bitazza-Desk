"""
Background job for automatic ticket state transitions.
Runs on a schedule via asyncio. Registered in api/main.py lifespan.

Rules (widget / all channels):
- pending_customer → snoozed after 48h of no activity
- snoozed → closed after snooze_until timestamp passes (7 days max)
- resolved → closed after 24h of no activity

Additional rules (email channel):
- email tickets stuck in pending_customer after 48h → Resolved (no reply = resolved)
- email verification tokens expired without being used → ticket escalated to human
"""
import asyncio
import logging
from db.conversation_store import get_tickets_for_auto_transition, update_ticket_status
from db.email_store import get_pending_verification_tickets


def is_workflow_active(ticket_id: str, **kwargs) -> bool:
    """Fail-open guard: if workflow_engine is unavailable, returns False."""
    try:
        from workflow_engine.store import is_workflow_active as _fn
        return _fn(ticket_id, **kwargs)
    except Exception:
        return False

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 900        # run every 15 minutes
EMAIL_POLL_MESSAGES = 20      # how many recent inbox messages to check each poll


async def run_auto_transitions() -> None:
    """Process all expired ticket states."""
    try:
        buckets = get_tickets_for_auto_transition()

        for ticket in buckets.get("pending_customer_expired", []):
            try:
                if is_workflow_active(ticket["id"]):
                    logger.debug("Skipping auto-transition for ticket %s — workflow active", ticket["id"])
                    continue
            except Exception:
                logger.debug("is_workflow_active guard failed for %s — processing ticket (fail-open)", ticket["id"])
            # Email: no customer reply → treat as resolved
            # Widget/other: customer dropped off → snooze for agent follow-up
            if ticket.get("channel") == "email":
                update_ticket_status(ticket["id"], "Resolved")
                logger.info("Auto-resolved email ticket %s (no customer reply)", ticket["id"])
            else:
                update_ticket_status(ticket["id"], "snoozed")
                logger.info(
                    "Auto-snoozed ticket %s (no customer reply after 48h, channel=%s)",
                    ticket["id"], ticket.get("channel", "unknown"),
                )

        for ticket in buckets.get("snoozed_expired", []):
            try:
                if is_workflow_active(ticket["id"]):
                    logger.debug("Skipping auto-transition for ticket %s — workflow active", ticket["id"])
                    continue
            except Exception:
                logger.debug("is_workflow_active guard failed for %s — processing ticket (fail-open)", ticket["id"])
            update_ticket_status(ticket["id"], "closed")
            logger.info("Auto-closed ticket %s (snooze expired)", ticket["id"])

        for ticket in buckets.get("resolved_expired", []):
            try:
                if is_workflow_active(ticket["id"]):
                    logger.debug("Skipping auto-transition for ticket %s — workflow active", ticket["id"])
                    continue
            except Exception:
                logger.debug("is_workflow_active guard failed for %s — processing ticket (fail-open)", ticket["id"])
            update_ticket_status(ticket["id"], "closed")
            logger.info("Auto-closed ticket %s (resolved 24h timeout)", ticket["id"])

        # Email identity verification: tokens expired without being used
        # → escalate ticket to human (can't verify identity automatically)
        expired_verifications = get_pending_verification_tickets()
        for row in expired_verifications:
            ticket_id = row["ticket_id"]
            update_ticket_status(ticket_id, "Escalated")
            logger.info(
                "Escalated email ticket %s — identity verification token expired unused "
                "(from_email=%s)",
                ticket_id, row.get("from_email", ""),
            )

    except Exception:
        logger.exception("Error in auto_transitions job")


async def start_auto_transition_loop() -> None:
    """Infinite loop — call this as an asyncio task from app lifespan."""
    while True:
        await run_auto_transitions()
        await asyncio.sleep(INTERVAL_SECONDS)
