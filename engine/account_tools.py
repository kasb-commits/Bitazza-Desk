"""
Account context tools — fetch live user data from Freedom/Bitazza backends.
All functions require an authenticated user_id from JWT (never from user message).

User profile + KYC data flow
─────────────────────────────
Development  : USE_MOCK_USER_API=true  → calls the local mock FastAPI router
Production   : USE_MOCK_USER_API=false → calls USER_API_BASE_URL with USER_API_KEY
               (API key sent as Bearer token; server is IP-whitelisted on the provider side)

To switch to the real API set these two env vars and flip the flag — no other code changes needed.
"""
import requests
from google import genai  # noqa: F401 — just to confirm settings load
from config import settings

# ── User/KYC API config ──────────────────────────────────────────────────────
_USE_MOCK = settings.USE_MOCK_USER_API
_USER_API_BASE = settings.USER_API_BASE_URL
_USER_API_KEY = settings.USER_API_KEY

_USER_HEADERS = {
    "Authorization": f"Bearer {_USER_API_KEY}",
    "Content-Type": "application/json",
}

# ── Other internal API base URLs ─────────────────────────────────────────────
FREEDOM_API_URL = settings.FREEDOM_API_URL
BITAZZA_API_URL = settings.BITAZZA_API_URL
INTERNAL_API_KEY = settings.INTERNAL_API_KEY

_HEADERS = {"x-internal-api-key": INTERNAL_API_KEY, "Content-Type": "application/json"}


def _get(base_url: str, path: str) -> dict:
    """Generic internal API GET. Returns {} on failure."""
    if not base_url:
        return {"error": "API not configured"}
    try:
        r = requests.get(f"{base_url}{path}", headers=_HEADERS, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _user_api_get(param: str, value: str) -> dict:
    """
    Single-user lookup against the User/KYC API (mock or real).
    param: one of 'user_id', 'email', 'phone'
    In mock mode, calls the in-process store directly to avoid HTTP self-call deadlock.
    """
    if _USE_MOCK:
        from engine.mock_api import users as user_store
        if param == "user_id":
            profile = user_store.get_by_user_id(value)
        elif param == "email":
            profile = user_store.get_by_email(value)
        elif param == "phone":
            profile = user_store.get_by_phone(value)
        else:
            return {"error": f"unknown param: {param}"}
        if profile is None:
            return {"error": "user_not_found"}
        return profile.model_dump(mode="json")

    prefix = ""
    url = f"{_USER_API_BASE}{prefix}/user"
    try:
        r = requests.get(url, params={param: value}, headers=_USER_HEADERS, timeout=5)
        if r.status_code == 404:
            return {"error": "user_not_found"}
        if r.status_code == 401:
            return {"error": "unauthorized"}
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


# ── Public tool functions (called by agent.py) ──────────────────────────────

def get_user_profile(user_id: str) -> dict:
    """
    Returns full user profile including KYC status for the authenticated user.
    Lookup is always by the JWT-derived user_id — never by client-supplied data.

    Response keys: user_id, first_name, last_name, email, phone, tier,
                   kyc.status, kyc.rejection_reason, kyc.reviewed_at
    """
    return _user_api_get("user_id", user_id)


def get_kyc_status(user_id: str) -> dict:
    """
    Returns KYC verification status for the user (convenience wrapper).
    Delegates to get_user_profile and extracts the kyc sub-object.
    """
    profile = get_user_profile(user_id)
    if "error" in profile:
        return profile
    return profile.get("kyc", {"error": "kyc data missing from profile"})


def _lookup_transactions(user_id: str, tx_type: str, tx_id: str | None) -> dict:
    """
    Shared logic for deposit/withdrawal lookups against the mock transaction store.
    tx_type: 'deposit' or 'withdrawal'
    Matches tx_id against transaction_id, tx_hash, or bank_ref.
    """
    from engine.mock_api import trading as trading_store
    from engine.mock_api.models import TransactionType
    t_enum = TransactionType.deposit if tx_type == "deposit" else TransactionType.withdrawal
    all_txns = [t for t in trading_store.get_transactions(user_id) if t.type == t_enum]
    if tx_id:
        match = next(
            (t for t in all_txns
             if t.transaction_id == tx_id or t.tx_hash == tx_id or t.bank_ref == tx_id),
            None,
        )
        if match is None:
            return {"error": "transaction_not_found", "tx_id": tx_id}
        return match.model_dump(mode="json")
    if not all_txns:
        return {"transactions": [], "total": 0}
    return {
        "transactions": [t.model_dump(mode="json") for t in all_txns[:5]],
        "total": len(all_txns),
    }


def get_deposit_status(user_id: str, tx_id: str | None = None) -> dict:
    """
    Returns recent deposit transactions or a specific deposit by tx_id.
    In mock mode, calls the in-process store directly to avoid HTTP self-call deadlock.
    Response keys: transactions (list) + total, or a single transaction if tx_id is given.
    Each transaction: transaction_id, type, status, currency, amount, fee,
                      network, tx_hash, bank_ref, created_at, completed_at.
    """
    if _USE_MOCK:
        return _lookup_transactions(user_id, "deposit", tx_id)
    # return _get(BITAZZA_API_URL, f"/internal/users/{user_id}/deposits" + (f"/{tx_id}" if tx_id else ""))
    return {"status": "stub", "amount": None, "currency": None, "updated_at": ""}


def get_withdrawal_status(user_id: str, tx_id: str | None = None) -> dict:
    """
    Returns recent withdrawal transactions or a specific withdrawal by tx_id.
    In mock mode, calls the in-process store directly to avoid HTTP self-call deadlock.
    Response keys: transactions (list) + total, or a single transaction if tx_id is given.
    Each transaction: transaction_id, type, status, currency, amount, fee,
                      network, tx_hash, bank_ref, created_at, completed_at.
    """
    if _USE_MOCK:
        return _lookup_transactions(user_id, "withdrawal", tx_id)
    # return _get(BITAZZA_API_URL, f"/internal/users/{user_id}/withdrawals" + (f"/{tx_id}" if tx_id else ""))
    return {"status": "stub", "amount": None, "currency": None, "updated_at": ""}


def get_account_restrictions(user_id: str) -> dict:
    """
    Returns active account restrictions for the authenticated user.
    Response keys: user_id, has_restrictions, restrictions (list), trading_available,
                   trading_block_reason.
    Each restriction: restriction_id, type, status, reason, applied_at,
                      expected_lift_at, can_self_resolve, resolution_steps.
    In mock mode, calls the in-process store directly to avoid HTTP self-call deadlock.
    """
    if _USE_MOCK:
        from engine.mock_api import restrictions as restriction_store
        result = restriction_store.get_by_user_id(user_id)
        if result is None:
            return {"user_id": user_id, "has_restrictions": False, "restrictions": [],
                    "trading_available": True, "trading_block_reason": None}
        return result.model_dump(mode="json")

    url = f"{_USER_API_BASE}/restrictions"
    try:
        r = requests.get(url, params={"user_id": user_id}, headers=_USER_HEADERS, timeout=5)
        if r.status_code == 401:
            return {"error": "unauthorized"}
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def get_trading_availability(user_id: str) -> dict:
    """
    Returns whether trading is available for the user.
    Derived from get_account_restrictions — no separate API call needed.
    """
    data = get_account_restrictions(user_id)
    if "error" in data:
        return data
    return {
        "available": data.get("trading_available", True),
        "reason": data.get("trading_block_reason") or "No trading restrictions active.",
    }


# ── Tool registry for agent.py ───────────────────────────────────────────────

TOOLS = {
    "get_user_profile": get_user_profile,
    "get_kyc_status": get_kyc_status,
    "get_deposit_status": get_deposit_status,
    "get_withdrawal_status": get_withdrawal_status,
    "get_account_restrictions": get_account_restrictions,
    "get_trading_availability": get_trading_availability,
}

# Gemini function declarations (for function calling)
TOOL_DEFINITIONS = [
    {
        "name": "get_user_profile",
        "description": (
            "Get the full profile of the authenticated user: name, email, phone, account tier, "
            "and KYC verification status (kyc.status, kyc.rejection_reason, kyc.reviewed_at). "
            "Call this FIRST for any account-specific issue — KYC status is a cross-cutting signal "
            "that can explain withdrawal failures, deposit blocks, and account restrictions."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_kyc_status",
        "description": (
            "Get only the KYC verification status for the authenticated user. "
            "Use get_user_profile instead when you need the full picture."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_deposit_status",
        "description": (
            "Get deposit status for the authenticated user. Optionally specify a transaction ID. "
            "Call this AFTER get_user_profile and get_account_restrictions — a KYC issue or active "
            "account restriction is often the real cause of a deposit failure, not the transaction itself."
        ),
        "parameters": {
            "type": "object",
            "properties": {"tx_id": {"type": "string", "description": "Optional transaction ID"}},
        },
    },
    {
        "name": "get_withdrawal_status",
        "description": (
            "Get withdrawal status for the authenticated user. Optionally specify a transaction ID. "
            "Call this AFTER get_user_profile and get_account_restrictions — unapproved KYC or an "
            "active account restriction is often the root cause of a blocked withdrawal, not the "
            "transaction state. Only use this for transaction-level details once account-level causes "
            "have been ruled out."
        ),
        "parameters": {
            "type": "object",
            "properties": {"tx_id": {"type": "string", "description": "Optional transaction ID"}},
        },
    },
    {
        "name": "get_account_restrictions",
        "description": (
            "Get any active restrictions or freezes on the authenticated user's account. "
            "Call this for ANY reported blockage — withdrawal failures, deposit issues, trading blocks, "
            "or account access problems. An active restriction is often the root cause of all of these. "
            "Always cross-reference with get_user_profile results to explain why the restriction exists."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_trading_availability",
        "description": "Check whether trading is currently available for the authenticated user.",
        "parameters": {"type": "object", "properties": {}},
    },
]
