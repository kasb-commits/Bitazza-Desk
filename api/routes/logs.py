"""
Client-side log ingestion endpoint.

The dashboard and widget send batches of log events here. This endpoint writes
them to stdout via the Python logger so they appear in Railway logs alongside
backend events — with the same formatter and log level controls.

Design constraints:
- Never writes to PostgreSQL — no schema, no migrations needed.
- Never raises an exception back to the client (fire-and-forget from frontend).
- Batch is capped at 50 entries to prevent abuse.
- No auth required — the endpoint is intentionally public (log payloads contain
  no secrets; only error messages, event names, and URLs).
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/logs", tags=["logs"])
logger = logging.getLogger("frontend.client")


class ClientLogEntry(BaseModel):
    level: str                    # "error" | "warn" | "info"
    event: str                    # e.g. "api_error", "react_error_boundary"
    message: str
    # All fields below are optional — schema is forwards-compatible
    conv_id: str | None = None
    ticket_id: str | None = None
    url: str | None = None
    component: str | None = None
    stack: str | None = None
    extra: dict | None = None     # catch-all for future fields


class ClientLogBatch(BaseModel):
    source: str                   # "dashboard" | "widget"
    entries: list[ClientLogEntry]


@router.post("/client")
async def receive_client_logs(batch: ClientLogBatch) -> dict:
    """
    Ingest frontend log events. Writes to stdout — Railway captures them.
    Returns {"ok": True} unconditionally — never raises.
    """
    try:
        _level_map = {
            "error": logger.error,
            "warn":  logger.warning,
            "warning": logger.warning,
        }
        for entry in batch.entries[:50]:
            log_fn = _level_map.get(entry.level, logger.info)
            extra: dict = {
                "source":    batch.source,
                "event":     entry.event,
            }
            if entry.conv_id:
                extra["conv_id"] = entry.conv_id
            if entry.ticket_id:
                extra["ticket_id"] = entry.ticket_id
            if entry.url:
                extra["url"] = entry.url
            if entry.component:
                extra["component"] = entry.component
            if entry.stack:
                extra["stack"] = entry.stack
            if entry.extra:
                extra.update(entry.extra)

            log_fn(entry.message, extra=extra)
    except Exception:
        logger.exception("client_log_ingest_error")

    return {"ok": True}
