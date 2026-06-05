"""
Centralized logging configuration for the CS Bot API.

Call configure_logging() once at startup (before the FastAPI app is built).
All logging.getLogger(__name__) calls in every module will route through the
single root handler configured here.

ContextVars (request_id_var, conversation_id_var) are set by
RequestLoggingMiddleware on every HTTP request and are read by both formatters
so that every log line carries the request/conversation context automatically —
no need to pass them explicitly to individual loggers.
"""
import json
import logging
import os
import traceback
from contextvars import ContextVar

# ---------------------------------------------------------------------------
# Shared ContextVar singletons
# Imported by logging_middleware (to set) and read by formatters (on every
# format() call) so all downstream loggers carry context automatically.
# ---------------------------------------------------------------------------
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
conversation_id_var: ContextVar[str | None] = ContextVar("conversation_id", default=None)

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_FORMAT = os.getenv("LOG_FORMAT", "text")  # "json" | "text"

# Fields that are part of LogRecord internals — excluded from extra= passthrough
_STDLIB_LOG_RECORD_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "taskName",
})


class ContextAwareJsonFormatter(logging.Formatter):
    """
    Emits one JSON object per line (ndjson).
    Reads request_id and conv_id from ContextVars on every format() call so
    they appear automatically in every log record from any module.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts":         self.formatTime(record, datefmt="%Y-%m-%dT%H:%M:%S"),
            "level":      record.levelname,
            "logger":     record.name,
            "request_id": request_id_var.get("-"),
            "conv_id":    conversation_id_var.get(None),
            "msg":        record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Pass through any extra= fields the caller attached
        for key, val in record.__dict__.items():
            if key not in _STDLIB_LOG_RECORD_ATTRS and not key.startswith("_"):
                payload[key] = val
        return json.dumps(payload, ensure_ascii=False, default=str)


class ContextAwareTextFormatter(logging.Formatter):
    """
    Human-readable format for local development:
    2026-06-05 12:34:56 INFO     api.routes.chat [req=abc123 conv=xyz] Message
    """

    _FMT = "%(asctime)s %(levelname)-8s %(name)s [req=%(request_id)s%(conv_part)s] %(message)s"
    _DATEFMT = "%Y-%m-%d %H:%M:%S"

    def __init__(self) -> None:
        super().__init__(fmt=self._FMT, datefmt=self._DATEFMT)

    def format(self, record: logging.LogRecord) -> str:
        record.request_id = request_id_var.get("-")
        conv = conversation_id_var.get(None)
        record.conv_part = f" conv={conv}" if conv else ""
        formatted = super().format(record)
        # Append extra= fields as key=value pairs after the message
        extras = {
            k: v for k, v in record.__dict__.items()
            if k not in _STDLIB_LOG_RECORD_ATTRS
            and not k.startswith("_")
            and k not in ("request_id", "conv_part")
        }
        if extras:
            pairs = " ".join(f"{k}={v!r}" for k, v in extras.items())
            formatted = f"{formatted} | {pairs}"
        if record.exc_info:
            formatted += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
        return formatted


def configure_logging() -> None:
    """
    Wire all logging.getLogger() calls to a single StreamHandler → stdout.
    Idempotent — safe to call more than once (e.g. in test setUp).
    """
    level = getattr(logging, LOG_LEVEL, logging.INFO)
    formatter: logging.Formatter = (
        ContextAwareJsonFormatter()
        if LOG_FORMAT == "json"
        else ContextAwareTextFormatter()
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)

    # Avoid duplicate handlers if called multiple times
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        root.addHandler(handler)

    # Quiet noisy third-party loggers that would otherwise flood stdout
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)   # replaced by our middleware
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("google.auth").setLevel(logging.WARNING)
    logging.getLogger("google.auth.transport").setLevel(logging.WARNING)
    logging.getLogger("chromadb").setLevel(logging.WARNING)
    logging.getLogger("googleapiclient.discovery_cache").setLevel(logging.ERROR)
