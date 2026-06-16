"""
Widget session bootstrap — Plane-B entry point for the Bitazza Exchange integration.

POST /widget/session/init  { "wst_bootstrap": "wstb_..." }
  → exchanges the single-use bootstrap for a downstream token (server-side, via
    engine.exchange_client) and returns OUR own JWT for the widget to carry as a
    normal Bearer token. The wstd_* never leaves the server.

No auth dependency on this route — it IS the authentication step. The issued JWT
matches the exact format the existing middleware validates (sub/iat/exp, HS256,
JWT_SECRET) — see engine/mock_api/auth.py and api/middleware/auth.py.
"""
import logging
import re
import time

from fastapi import APIRouter, HTTPException
from jose import jwt
from pydantic import BaseModel

from config.settings import JWT_SECRET, JWT_ALGORITHM
from engine import exchange_client

logger = logging.getLogger("api.widget_session")

router = APIRouter(prefix="/widget", tags=["widget-session"])

_BOOTSTRAP_RE = re.compile(r"^wstb_[A-Za-z0-9_-]{43}$")
SESSION_TTL_SECONDS = 3600  # matches the wstd_* absolute max; the session ends with it


class InitRequest(BaseModel):
    wst_bootstrap: str


class InitResponse(BaseModel):
    token: str
    user_id: str
    expires_in: int


@router.post(
    "/session/init",
    response_model=InitResponse,
    summary="Exchange a single-use widget bootstrap token for a session JWT.",
)
def init_session(body: InitRequest) -> InitResponse:
    if not _BOOTSTRAP_RE.match(body.wst_bootstrap):
        raise HTTPException(status_code=400, detail="Invalid bootstrap token format")

    result = exchange_client.introspect_bootstrap(body.wst_bootstrap)
    if "error" in result:
        logger.warning("widget_session_init_failed", extra={"reason": result["error"]})
        raise HTTPException(status_code=502, detail="Could not establish session with exchange")

    user_id = result["user_id"]
    now = int(time.time())
    payload = {"sub": user_id, "iat": now, "exp": now + SESSION_TTL_SECONDS}
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    logger.info("widget_session_init_ok", extra={"user_id": user_id})
    return InitResponse(token=token, user_id=user_id, expires_in=SESSION_TTL_SECONDS)
