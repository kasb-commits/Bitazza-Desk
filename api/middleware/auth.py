"""JWT auth middleware — extracts and validates user_id from Bearer token."""
from fastapi import HTTPException, Header
from jose import jwt, JWTError
from config.settings import JWT_SECRET, JWT_ALGORITHM, ENV


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
    except (JWTError, ValueError):
        return None


def get_user_id(
    authorization: str = Header(default=""),
) -> str:
    """
    Extract user_id from Authorization: Bearer <token>.

    - Production (ENV=production): JWT token is mandatory; no fallback.
    - Development: missing token falls back to 'dev_user' for easy local testing.
    """
    user_id = _decode_token(authorization)
    if user_id:
        return user_id
    if not authorization:
        if ENV == "production":
            raise HTTPException(status_code=401, detail="Authorization header required")
        return "dev_user"
    # authorization was present but invalid
    if authorization.split(" ", 1)[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid auth scheme")
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
