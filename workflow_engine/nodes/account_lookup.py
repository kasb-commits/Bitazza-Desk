"""
account_lookup node — fetches account data using authenticated user_id.

user_id always comes from ExecutionContext (JWT-derived), never from node config.
Calls update_customer_from_profile on success — mandatory side effect.

Per-node API override:
  If node.config contains "api_url", the node makes a direct HTTP GET to
  {api_url}/{endpoint} with Authorization: Bearer {api_key} instead of
  calling the global tool functions. Falls back to tool functions when absent.
"""
from __future__ import annotations
import logging
from workflow_engine.models import WorkflowNode, ExecutionContext, NodeResult

logger = logging.getLogger(__name__)

# Maps both Studio short names and full function names → actual function name
_TOOL_MAP = {
    # Short names used in Studio UI
    "profile":       "get_user_profile",
    "kyc_status":    "get_kyc_status",
    "balance":       "get_deposit_status",
    "transactions":  "get_withdrawal_status",
    "limits":        "get_trading_availability",
    "restrictions":  "get_account_restrictions",
    # Full function names (backwards compat)
    "get_user_profile":         "get_user_profile",
    "get_account_restrictions": "get_account_restrictions",
    "get_kyc_status":           "get_kyc_status",
    "get_deposit_status":       "get_deposit_status",
    "get_withdrawal_status":    "get_withdrawal_status",
    "get_trading_availability": "get_trading_availability",
}

# Maps short tool names → URL path segments for external API calls
_TOOL_ENDPOINT = {
    "profile":                  "profile",
    "kyc_status":               "kyc",
    "balance":                  "balance",
    "transactions":             "transactions",
    "limits":                   "limits",
    "restrictions":             "restrictions",
    "get_user_profile":         "profile",
    "get_account_restrictions": "restrictions",
    "get_kyc_status":           "kyc",
    "get_deposit_status":       "balance",
    "get_withdrawal_status":    "transactions",
    "get_trading_availability": "limits",
}


def _call_external_api(api_url: str, api_key: str, endpoint: str, user_id: str) -> dict:
    """Make GET {api_url}/{endpoint} with Bearer auth and user_id query param."""
    import urllib.request
    import urllib.parse
    import json as _json

    base = api_url.rstrip("/")
    qs = urllib.parse.urlencode({"user_id": user_id})
    url = f"{base}/{endpoint}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return _json.loads(resp.read())
    except Exception as exc:
        logger.warning("External API call to %s failed: %s", url, exc)
        return {"error": str(exc)}


def get_user_profile(user_id: str) -> dict:
    from engine.account_tools import get_user_profile as _fn
    return _fn(user_id=user_id)


def update_customer_from_profile(user_id: str, profile: dict) -> None:
    from db.conversation_store import update_customer_from_profile as _fn
    _fn(user_id, profile)


class AccountLookupNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        tool_name = node.config.get("tool", "get_user_profile")
        user_id   = ctx.user_id
        api_url   = node.config.get("api_url", "").strip()

        # Guest session: no account data available — return a helpful fallback
        # so the workflow can continue to AiReplyNode which will use the KB.
        if user_id is None:
            return NodeResult(
                output={
                    "guest_session": True,
                    "message": (
                        "User is not authenticated. Provide general guidance from the "
                        "knowledge base. Tell the user to log in for account-specific details."
                    ),
                },
                next_node_id=node.next_node_id,
            )
        api_key   = node.config.get("api_key", "").strip()
        store_as  = node.config.get("store_as", tool_name)

        # ── External API path ─────────────────────────────────────────────────
        if api_url:
            endpoint = _TOOL_ENDPOINT.get(tool_name, tool_name)
            logger.info("account_lookup_called", extra={
                "node_id": node.id, "conv_id": ctx.conversation_id,
                "tool": tool_name, "store_as": store_as, "external_api": True,
            })
            result = _call_external_api(api_url, api_key, endpoint, user_id)
            logger.info("account_lookup_result", extra={
                "node_id": node.id, "tool": tool_name, "has_error": "error" in result,
            })
            if tool_name in ("profile", "get_user_profile") and "error" not in result:
                update_customer_from_profile(user_id, result)
            return NodeResult(
                output={store_as: result},
                next_node_id=node.next_node_id,
            )

        # ── Built-in tool path ────────────────────────────────────────────────
        logger.info("account_lookup_called", extra={
            "node_id": node.id, "conv_id": ctx.conversation_id,
            "tool": tool_name, "store_as": store_as, "external_api": False,
        })
        if tool_name not in _TOOL_MAP:
            logger.warning("Unknown account tool: %s", tool_name)
            return NodeResult(
                output={"error": f"Unknown tool: {tool_name}"},
                next_node_id=node.next_node_id,
            )

        fn_name = _TOOL_MAP[tool_name]

        if fn_name == "get_user_profile":
            result = get_user_profile(user_id=user_id)
            if "error" not in result:
                update_customer_from_profile(user_id, result)
            return NodeResult(
                output={"profile": result},
                next_node_id=node.next_node_id,
            )

        from engine import account_tools
        fn = getattr(account_tools, fn_name, None)
        if fn is None:
            return NodeResult(
                output={"error": f"Tool not implemented: {fn_name}"},
                next_node_id=node.next_node_id,
            )
        result = fn(user_id=user_id)
        return NodeResult(
            output={store_as: result},
            next_node_id=node.next_node_id,
        )
