"""
Background notification scanner — runs every 5 minutes.

Fires time-based notifications that can't be triggered by a single event:
  - sla_warning  : ticket >= 80% of SLA target, not yet breached
  - sla_breach   : ticket >= 100% of SLA target
  - vip_waiting  : priority-1 ticket unassigned for > 5 minutes

All three are deduplicated: a notification of the same type for the same
ticket won't fire again within the cooldown window.

Event-based notifications (assigned, customer_reply, whisper, escalated,
agent_offline) are NOT handled here — they fire immediately at their event
point in the relevant route or socket handler.
"""
import asyncio
import logging
import time

from db.conversation_store import get_open_tickets
from engine.notifications import (
    fan_out_to_supervisors,
    notification_recently_exists,
)

log = logging.getLogger(__name__)

# SLA targets in seconds, keyed by ticket priority (1=VIP, 2=EA, 3=Standard)
_SLA_TARGETS = {1: 4 * 3600, 2: 8 * 3600, 3: 24 * 3600}
_SLA_WARNING_PCT = 0.80        # fire warning when >= 80% elapsed
_VIP_WAIT_THRESHOLD = 5 * 60  # fire vip_waiting when unassigned > 5 min

# Dedup windows: don't re-fire same type for same ticket within this many seconds
_DEDUP = {
    "sla_warning": 3600,       # at most once per hour
    "sla_breach":  6 * 3600,   # at most once per 6 hours
    "vip_waiting": 3600,       # at most once per hour
}

SCAN_INTERVAL = 60  # seconds between scans


def _scan() -> list:
    """
    Synchronous scan — called inside asyncio.to_thread so DB queries
    don't block the event loop. Returns list of newly created notification dicts.
    """
    tickets = get_open_tickets(status_filter="all")
    now = int(time.time())
    new_notifs = []

    for t in tickets:
        status = t.get("status", "")
        if status in ("Closed_Resolved", "Closed_Unresponsive", "Orphaned"):
            continue

        ticket_id = t["id"]
        priority = t.get("priority") or 3
        created_at = t.get("created_at")
        if not created_at:
            continue

        elapsed = now - created_at
        target = _SLA_TARGETS.get(priority, _SLA_TARGETS[3])
        pct = elapsed / target

        tier_label = {1: "VIP", 2: "EA", 3: "Standard"}.get(priority, "Standard")
        customer_name = (t.get("customer") or {}).get("name") or "A customer"

        # ── sla_breach ────────────────────────────────────────────────────────
        if pct >= 1.0:
            if not notification_recently_exists(ticket_id, "sla_breach", _DEDUP["sla_breach"]):
                title = f"SLA Breached — Ticket #{ticket_id[:8]}"
                body  = f"{customer_name} ({tier_label}) — response time exceeded"
                notifs = fan_out_to_supervisors(
                    type="sla_breach",
                    priority="critical",
                    title=title,
                    body=body,
                    ticket_id=ticket_id,
                )
                new_notifs.extend(notifs)
                # Also notify assigned agent if any (shares the same dedup window)
                assigned_to = t.get("assigned_to") or t.get("assigned_agent_id")
                if assigned_to:
                    from engine.notifications import create_notification
                    notif = create_notification(
                        user_id=str(assigned_to),
                        role="agent",
                        type="sla_breach",
                        priority="critical",
                        title=title,
                        body=body,
                        ticket_id=ticket_id,
                    )
                    new_notifs.append(notif)

        # ── sla_warning (only if not yet breached) ────────────────────────────
        elif pct >= _SLA_WARNING_PCT:
            if not notification_recently_exists(ticket_id, "sla_warning", _DEDUP["sla_warning"]):
                pct_int = int(pct * 100)
                notifs = fan_out_to_supervisors(
                    type="sla_warning",
                    priority="high",
                    title=f"SLA Warning — Ticket #{ticket_id[:8]}",
                    body=f"{customer_name} ({tier_label}) — {pct_int}% of SLA target elapsed",
                    ticket_id=ticket_id,
                )
                new_notifs.extend(notifs)

        # ── vip_waiting ───────────────────────────────────────────────────────
        if priority == 1:
            assigned_to = t.get("assigned_to") or t.get("assigned_agent_id")
            if not assigned_to and elapsed >= _VIP_WAIT_THRESHOLD:
                if not notification_recently_exists(ticket_id, "vip_waiting", _DEDUP["vip_waiting"]):
                    waited_min = int(elapsed // 60)
                    notifs = fan_out_to_supervisors(
                        type="vip_waiting",
                        priority="critical",
                        title=f"VIP Waiting — Ticket #{ticket_id[:8]}",
                        body=f"{customer_name} unassigned for {waited_min} minutes",
                        ticket_id=ticket_id,
                    )
                    new_notifs.extend(notifs)

    return new_notifs


async def _run_scan(manager) -> None:
    """Run one scan cycle and broadcast any new notifications."""
    try:
        new_notifs = await asyncio.to_thread(_scan)
        for notif in new_notifs:
            try:
                await manager.broadcast_all({"type": "notification:new", "notification": notif})
            except Exception:
                log.exception("[notification_scanner] broadcast error for notif %s", notif.get("id"))
        if new_notifs:
            log.info("[notification_scanner] fired %d notification(s)", len(new_notifs))
    except Exception:
        log.exception("[notification_scanner] scan error")


async def start_notification_scanner_loop(manager) -> None:
    """
    Asyncio background task — registered in api/main.py lifespan.
    Waits 30s after startup, then scans every SCAN_INTERVAL seconds.
    """
    await asyncio.sleep(30)
    log.info("[notification_scanner] started (interval=%ds)", SCAN_INTERVAL)
    while True:
        await _run_scan(manager)
        await asyncio.sleep(SCAN_INTERVAL)
