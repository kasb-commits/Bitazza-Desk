"""JWT auth middleware — extracts and validates user_id from Bearer token."""
import logging

from fastapi import HTTPException, Header
from jose import jwt, JWTError
from config.settings import JWT_SECRET, JWT_ALGORITHM, ENV, INTERNAL_SERVICE_TOKEN

logger = logging.getLogger("api.auth")


def _decode_token(authorization: str) -> str | None:
    """
    Decode a Bearer JWT and return the user_id, or None on any failure.
    Shared by both get_user_id (strict) and get_optional_user_id (lenient).
    """
    if not authorization:
        return None
    try:
        scheme, token = authorization.split(" ", 1)
        if scheme.lower() != "bearer":
            return None
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub") or payload.get("user_id") or payload.get("id")
        return str(user_id) if user_id else None
    except (JWTError, ValueError) as e:
        logger.warning("jwt_validation_failed", extra={"reason": str(e)})
        return None


def _decode_region(authorization: str) -> str | None:
    """Extract the 'region' claim from a Bearer JWT. Returns None if absent or invalid."""
    if not authorization:
        return None
    try:
        scheme, token = authorization.split(" ", 1)
        if scheme.lower() != "bearer":
            return None
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        region = payload.get("region")
        return str(region) if region else None
    except (JWTError, ValueError):
        return None


def get_region(authorization: str = Header(default="")) -> str | None:
    """FastAPI dependency: extract region from JWT. Never raises — returns None if absent."""
    return _decode_region(authorization)


def decode_raw_token(token: str) -> str | None:
    """Validate a raw JWT string (no 'Bearer ' prefix). Returns user_id or None.
    Used by non-header auth contexts such as WebSocket first-message handshakes."""
    return _decode_token(f"Bearer {token}")


def get_user_id(
    authorization: str = Header(default=""),
    x_internal_token: str = Header(default=""),
) -> str:
    """
    Extract user_id from Authorization: Bearer <token>.

    Also accepts X-Internal-Token for service-to-service calls (e.g. dashboard
    server proxying to Python API without a user JWT).

    - Production (ENV=production): JWT token is mandatory; no fallback.
    - Development: missing token falls back to 'dev_user' for easy local testing.
    """
    if x_internal_token and INTERNAL_SERVICE_TOKEN and x_internal_token == INTERNAL_SERVICE_TOKEN:
        return "internal_service"
    user_id = _decode_token(authorization)
    if user_id:
        return user_id
    if not authorization:
        if ENV == "production":
            logger.warning("auth_rejected", extra={"reason": "missing_token"})
            raise HTTPException(status_code=401, detail="Authorization header required")
        return "dev_user"
    # authorization was present but invalid
    if authorization.split(" ", 1)[0].lower() != "bearer":
        logger.warning("auth_rejected", extra={"reason": "invalid_scheme"})
        raise HTTPException(status_code=401, detail="Invalid auth scheme")
    logger.warning("auth_rejected", extra={"reason": "invalid_token"})
    raise HTTPException(status_code=401, detail="Invalid token")


def get_optional_user_id(
    authorization: str = Header(default=""),
) -> str | None:
    """
    Extract user_id from Authorization: Bearer <token>, or return None.
    Never raises 401 — used for guest-friendly endpoints.
    Dev mode: missing token → None (keeps local guest testing consistent).
    """
    return _decode_token(authorization)
