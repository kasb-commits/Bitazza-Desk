import asyncio
import logging
import os

import httpx

log = logging.getLogger(__name__)
DASHBOARD_INTERNAL_URL = os.getenv("DASHBOARD_INTERNAL_URL", "http://localhost:4000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "internal-dev-token")

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=3.0)
    return _client


async def _fire(ticket_id, category, priority, customer_id):
    url = f"{DASHBOARD_INTERNAL_URL}/api/internal/tickets/{ticket_id}/auto-assign"
    try:
        await _get_client().post(
            url,
            json={"category": category, "priority": priority, "customer_id": customer_id},
            headers={"X-Internal-Secret": INTERNAL_SECRET},
        )
    except Exception as exc:
        log.warning("[assignment] call failed ticket=%s: %s", ticket_id, exc)


def trigger_auto_assign(ticket_id, category, priority, customer_id):
    """Schedule async HTTP call; works from both async and sync contexts."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_fire(ticket_id, category, priority, customer_id))
    except RuntimeError:
        # Sync context (workflow engine) — use sync httpx
        try:
            httpx.post(
                f"{DASHBOARD_INTERNAL_URL}/api/internal/tickets/{ticket_id}/auto-assign",
                json={"category": category, "priority": priority, "customer_id": customer_id},
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                timeout=3.0,
            )
        except Exception as exc:
            log.warning("[assignment] sync call failed ticket=%s: %s", ticket_id, exc)


async def emit_ticket_event(ticket_id: str, event: str, payload: dict) -> None:
    """Fire-and-forget: emit a socket event to all dashboard agents viewing this ticket."""
    url = f"{DASHBOARD_INTERNAL_URL}/api/internal/emit"
    try:
        await _get_client().post(
            url,
            json={"event": event, "ticket_id": ticket_id, "payload": payload},
            headers={"X-Internal-Secret": INTERNAL_SECRET},
        )
    except Exception as exc:
        log.warning("[dashboard] emit failed ticket=%s event=%s: %s", ticket_id, event, exc)
