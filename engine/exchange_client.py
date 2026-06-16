"""
Bitazza Exchange — Widget Session client (auth + KYC, staging).

Plays the "Widget-BE" role from the integration sequence diagram: exchanges a
single-use bootstrap token (wstb_*) for a downstream bearer token (wstd_*) via an
HMAC-signed introspect call, then uses that wstd_* for HMAC-signed get-kyc calls
on behalf of the LLM agent. The wstd_* never leaves this process — only our own
JWT is handed to the widget.

Signing matches the Exchange HmacGuard exactly:
    body_hash = HMAC_SHA256(key=b"",                  msg=body_str)   # empty key
    canonical = "\\n".join([timestamp, nonce, METHOD, hmac_path, body_hash])
    signature = HMAC_SHA256(key=WIDGET_HMAC_SECRET,   msg=canonical)
Bodies are serialized compact (no spaces) so the bytes hashed are byte-identical
to the bytes sent — i.e. JSON.stringify-compatible.

Functions return plain dicts and never raise to the caller; failures come back as
{"error": "..."} so the agent's tool loop (which checks `"error" in result`) is
unaffected. Synchronous on purpose — account_tools tools are called synchronously
by the agent (engine/agent.py).

Endpoint paths follow the team's Postman collection ("source of truth"); URL path
and HMAC canonical path intentionally differ. If staging rejects a path it returns
401/403/404 — flip the relevant constant below (one line).
"""
import hashlib
import hmac
import json
import logging
import secrets
import time

import requests

from config import settings

log = logging.getLogger(__name__)

# ── Endpoint paths (Postman = source of truth) ───────────────────────────────
INTROSPECT_URL_PATH = "/widget-session/v1/introspect"   # request URL path
INTROSPECT_HMAC_PATH = "/v1/widget-session/introspect"  # path inside the signature
GET_KYC_URL_PATH = "/widget-session/v1/get-kyc"         # Postman literally "get-key"; treated as typo — watch on first staging call
GET_KYC_HMAC_PATH = "/v1/get-kyc"                        # Postman script + diagram agree

# We always call get-kyc to answer KYC-status questions; this hashes into the header.
_USER_INTENT = "what is my kyc status"
_TIMEOUT = 8.0

# user_id -> {"wstd": str, "issued_at": float}. In-memory for staging; pre-prod
# moves this to Redis/Postgres so it survives restarts and spans instances.
_sessions: dict[str, dict] = {}


def _sign(method: str, hmac_path: str, body_str: str) -> dict:
    """Build the common HMAC headers (X-Client-Id, X-Timestamp, X-Nonce,
    X-Signature, X-Request-Id) for one request."""
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hmac.new(b"", body_str.encode(), hashlib.sha256).hexdigest()
    canonical = "\n".join([timestamp, nonce, method, hmac_path, body_hash])
    signature = hmac.new(
        settings.WIDGET_HMAC_SECRET.encode(), canonical.encode(), hashlib.sha256
    ).hexdigest()
    return {
        "X-Client-Id": settings.WIDGET_CLIENT_ID,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
        "X-Request-Id": "req_" + secrets.token_hex(8),
    }


def _extract_user_id(data: dict) -> str | None:
    """Pull the user identifier out of the introspect response. The team confirms
    the field is `user_id` (an int); we accept common alternatives defensively and
    stringify to stay consistent with the rest of the system (string ids)."""
    candidates = [data]
    for nest in ("user_context", "user", "context"):
        nested = data.get(nest)
        if isinstance(nested, dict):
            candidates.append(nested)
    for obj in candidates:
        for key in ("user_id", "userId", "sub", "customer_id", "uid"):
            if obj.get(key) is not None:
                return str(obj[key])
    return None


def introspect_bootstrap(wst_bootstrap: str) -> dict:
    """
    Plane-B exchange: single-use wstb_* -> wstd_* downstream token.
    Stores the wstd_* keyed by the user_id from the response's user context.
    Returns {"user_id": "<id>"} on success, or {"error": "..."}.
    """
    if not settings.EXCHANGE_BE_BASE_URL or not settings.WIDGET_HMAC_SECRET:
        return {"error": "exchange_api_not_configured"}

    body_str = json.dumps({"wst_bootstrap": wst_bootstrap}, separators=(",", ":"))
    headers = _sign("POST", INTROSPECT_HMAC_PATH, body_str)
    headers["Content-Type"] = "application/json"
    url = f"{settings.EXCHANGE_BE_BASE_URL}{INTROSPECT_URL_PATH}"
    try:
        r = requests.post(url, data=body_str, headers=headers, timeout=_TIMEOUT)
        if r.status_code in (401, 403):
            return {"error": "introspect_unauthorized"}
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        log.warning("[exchange] introspect failed: %s", e)
        return {"error": f"introspect_failed: {e}"}

    wstd = data.get("wst_downstream")
    user_id = _extract_user_id(data)
    if not wstd or not user_id:
        # DEBUG so the exact response shape can be confirmed on the first staging call.
        log.warning("[exchange] introspect response incomplete — keys=%s", list(data.keys()))
        log.debug("[exchange] introspect raw response: %s", data)
        return {"error": "introspect_incomplete"}

    _sessions[user_id] = {"wstd": wstd, "issued_at": time.time()}
    return {"user_id": user_id}


def get_kyc(user_id: str) -> dict:
    """
    Phase-4 call: fetch the user's profile + KYC from the Exchange BE using the
    stored wstd_*. Returns the raw profile dict (user_id, first_name, last_name,
    email, phone, tier, region, kyc{status, rejection_reason, reviewed_at}) or
    {"error": "..."}.

    The Exchange derives the user from the wstd_* token itself; `user_id` here only
    keys our local session store. A 401/403 means the wstd_* expired (sliding TTL
    900s / absolute max 3600s) — we drop it and report session_expired.
    """
    session = _sessions.get(user_id)
    if not session:
        return {"error": "session_expired"}

    body_str = "{}"  # Express exposes a GET body as {}; HmacGuard signs "{}"
    headers = _sign("GET", GET_KYC_HMAC_PATH, body_str)
    headers.update({
        "Authorization": f"Bearer {session['wstd']}",
        "Accept": "application/json",
        "X-Caller-Type": "llm-agent",
        "X-LLM-Session-Id": secrets.token_hex(16),
        "X-LLM-Model": settings.MODEL,
        "X-User-Intent-Hash": hashlib.sha256(_USER_INTENT.encode()).hexdigest(),
        "X-Idempotency-Key": secrets.token_hex(16),
    })
    url = f"{settings.EXCHANGE_BE_BASE_URL}{GET_KYC_URL_PATH}"
    try:
        r = requests.get(url, headers=headers, timeout=_TIMEOUT)
        if r.status_code in (401, 403):
            _sessions.pop(user_id, None)
            return {"error": "session_expired"}
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("[exchange] get-kyc failed user=%s: %s", user_id, e)
        return {"error": f"get_kyc_failed: {e}"}


def clear_session(user_id: str) -> None:
    """Drop a stored downstream token (e.g. on logout/session end)."""
    _sessions.pop(user_id, None)
