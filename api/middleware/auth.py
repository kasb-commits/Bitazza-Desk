"""JWT auth middleware — extracts and validates user_id from Bearer token."""
from fastapi import HTTPException, Header
from jose import jwt, JWTError
from config.settings import JWT_SECRET, JWT_ALGORITHM, ENV


def get_user_id(
    authorization: str = Header(default=""),
) -> str:
    """
    Extract user_id from Authorization: Bearer <token>.

    - Production (ENV=production): JWT token is mandatory; no fallback.
    - Development: missing token falls back to 'dev_user' for easy local testing.
    """
    if not authorization:
        if ENV == "production":
            raise HTTPException(status_code=401, detail="Authorization header required")
        return "dev_user"

    try:
        scheme, token = authorization.split(" ", 1)
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid auth scheme")
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub") or payload.get("user_id") or payload.get("id")
        if not user_id:
            raise HTTPException(status_code=401, detail="Token missing user id")
        return str(user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except ValueError:
        raise HTTPException(status_code=401, detail="Malformed Authorization header")
