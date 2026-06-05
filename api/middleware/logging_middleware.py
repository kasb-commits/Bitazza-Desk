"""
Request logging middleware for the CS Bot API.

Responsibilities:
- Generate a UUID4 request_id (or accept X-Request-ID from upstream)
- Set request_id_var and conversation_id_var ContextVars so every downstream
  log line carries them automatically without explicit passing
- Log request_start and request_complete (with latency) for every HTTP request
- Inject X-Request-ID into the response headers for client-side correlation
- Catch and re-raise unhandled exceptions after logging them at ERROR level

Middleware ordering note:
Starlette processes middleware in LIFO order (last added = outermost wrapper).
This middleware should be added AFTER CORSMiddleware so that logging wraps
the entire stack, including CORS-rejected requests.
"""
import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from api.logging_config import conversation_id_var, request_id_var

logger = logging.getLogger("api.access")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        # Accept a forwarded request_id (e.g. from a load balancer or another service)
        # so that cross-service traces share the same ID.
        req_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        token_req = request_id_var.set(req_id)

        # Pre-populate conv_id from query string if present.
        # Routes that know the conversation_id will call conversation_id_var.set()
        # themselves to override this with the real value.
        conv_id = request.query_params.get("conversation_id")
        token_conv = conversation_id_var.set(conv_id)

        t0 = time.perf_counter()
        logger.info(
            "request_start",
            extra={"method": request.method, "path": request.url.path},
        )

        try:
            response = await call_next(request)
        except Exception:
            latency_ms = round((time.perf_counter() - t0) * 1000, 1)
            logger.exception(
                "request_unhandled_exception",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "latency_ms": latency_ms,
                },
            )
            raise
        finally:
            request_id_var.reset(token_req)
            conversation_id_var.reset(token_conv)

        latency_ms = round((time.perf_counter() - t0) * 1000, 1)
        status = response.status_code
        level = logging.WARNING if status >= 400 else logging.INFO
        logger.log(
            level,
            "request_complete",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": status,
                "latency_ms": latency_ms,
            },
        )

        response.headers["X-Request-ID"] = req_id
        return response
