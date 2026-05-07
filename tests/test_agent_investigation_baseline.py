"""
Baseline regression tests — document CURRENT investigation behavior, including known gaps.

These tests MUST NOT be changed when fixing the gaps. Instead, update them to reflect
new intended behavior AFTER a fix is implemented and verified end-to-end.

Run with: pytest tests/test_agent_investigation_baseline.py -v
"""
import json
from unittest.mock import MagicMock, patch

import pytest


# ── Response helpers ──────────────────────────────────────────────────────────

def _text_response(text: str) -> MagicMock:
    """Minimal Gemini response: plain text, no function call."""
    part = MagicMock()
    part.text = text
    part.function_call = None
    content = MagicMock()
    content.parts = [part]
    candidate = MagicMock()
    candidate.content = content
    resp = MagicMock()
    resp.candidates = [candidate]
    return resp


def _fn_call_response(tool_name: str) -> MagicMock:
    """Gemini responds with a function call (no text yet)."""
    fn_call = MagicMock()
    fn_call.name = tool_name
    fn_call.args = {}
    fn_part = MagicMock()
    fn_part.function_call = fn_call
    fn_part.text = None
    content = MagicMock()
    content.parts = [fn_part]
    candidate = MagicMock()
    candidate.content = content
    resp = MagicMock()
    resp.candidates = [candidate]
    return resp


def _json_payload(response: str, confidence: float = 0.85, needs_human: bool = False) -> str:
    return json.dumps({"response": response, "confidence": confidence, "needs_human": needs_human})


def _mock_tool(result: dict):
    """Return a callable that ignores its args and returns result."""
    return lambda user_id=None, **kwargs: result


# ── Base fixture ──────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def mock_base():
    with (
        patch("engine.agent.client") as mock_client,
        patch("engine.agent.get_history", return_value=[]),
        patch("engine.agent.collection_count", return_value=0),
        patch("engine.agent.retrieve_with_fallback", return_value=[]),
        patch("engine.agent.get_ticket_id_by_conversation", return_value="t-baseline"),
        patch("engine.agent.update_ticket_status"),
        patch("engine.agent.get_ai_persona", return_value=None),
        patch("engine.agent.update_customer_from_profile"),
    ):
        yield mock_client


# ── 1. Workflow guard ─────────────────────────────────────────────────────────

_NO_WORKFLOW = patch(
    "workflow_engine.store.get_published_workflows_by_trigger",
    return_value=[],
)
_HAS_WORKFLOW = patch(
    "workflow_engine.store.get_published_workflows_by_trigger",
    return_value=[{"id": "wf-1", "name": "test-workflow"}],
)


class TestWorkflowGuard:
    """
    Account-specific categories escalate immediately when no active workflow is published.
    Gemini is never called — the guard fires before RAG or LLM.

    The workflow store is explicitly patched in every test so behavior is independent
    of whatever workflows are currently published in the local/CI database.
    """

    def test_withdrawal_issue_no_workflow_escalates_immediately(self, mock_base):
        with _NO_WORKFLOW:
            from engine.agent import chat
            result = chat("conv-wg-1", "USR-001", "My withdrawal is stuck", category="withdrawal_issue")
        assert result.escalated is True
        assert result.escalation_reason == "no_active_workflow"
        mock_base.models.generate_content.assert_not_called()

    def test_account_restriction_no_workflow_escalates_immediately(self, mock_base):
        with _NO_WORKFLOW:
            from engine.agent import chat
            result = chat("conv-wg-2", "USR-001", "My account is blocked", category="account_restriction")
        assert result.escalated is True
        assert result.escalation_reason == "no_active_workflow"
        mock_base.models.generate_content.assert_not_called()

    def test_kyc_verification_no_workflow_escalates_immediately(self, mock_base):
        with _NO_WORKFLOW:
            from engine.agent import chat
            result = chat("conv-wg-3", "USR-001", "What is my KYC status?", category="kyc_verification")
        assert result.escalated is True
        assert result.escalation_reason == "no_active_workflow"
        mock_base.models.generate_content.assert_not_called()

    def test_deposit_issue_no_workflow_escalates_immediately(self, mock_base):
        """
        'deposit_issue' is in _ACCOUNT_CATEGORIES — without an active workflow it escalates
        immediately, same as withdrawal_issue / kyc_verification / account_restriction.
        """
        with _NO_WORKFLOW:
            from engine.agent import chat
            result = chat("conv-wg-4", "USR-001", "My deposit didn't arrive", category="deposit_issue")
        assert result.escalated is True
        assert result.escalation_reason == "no_active_workflow"
        mock_base.models.generate_content.assert_not_called()

    def test_trade_issue_no_workflow_escalates_immediately(self, mock_base):
        """'trade_issue' is in _ACCOUNT_CATEGORIES — escalates immediately with no active workflow."""
        with _NO_WORKFLOW:
            from engine.agent import chat
            result = chat("conv-wg-6", "USR-001", "My order was not filled", category="trade_issue")
        assert result.escalated is True
        assert result.escalation_reason == "no_active_workflow"
        mock_base.models.generate_content.assert_not_called()

    def test_other_category_bypasses_workflow_guard(self, mock_base):
        """'other' category bypasses the workflow guard and tools are omitted from the Gemini call."""
        mock_base.models.generate_content.return_value = _text_response(
            _json_payload("How can I help you today?", confidence=0.8)
        )
        from engine.agent import chat
        result = chat("conv-wg-5", "USR-001", "I have a general question", category="other")
        mock_base.models.generate_content.assert_called_once()
        assert result.escalated is False


# ── 2. Turn-1 tool forcing ────────────────────────────────────────────────────

_FAKE_PROFILE = {"user_id": "USR-001", "kyc": {"status": "approved"}, "tier": "standard"}


class TestTurn1ToolForcing:
    """
    When a workflow IS active, withdrawal_issue and account_restriction force
    get_user_profile on turn 1 before Gemini can produce a text reply.
    """

    def test_withdrawal_turn1_forces_get_user_profile(self, mock_base):
        with (
            _HAS_WORKFLOW,
            patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(_FAKE_PROFILE)}),
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_user_profile"),
                _text_response(_json_payload("Your account looks fine.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat("conv-t1-1", "USR-001", "My withdrawal is stuck", category="withdrawal_issue")

        # Two Gemini calls: first returns fn_call, second returns text after tool result is fed back
        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False

    def test_account_restriction_turn1_forces_get_user_profile(self, mock_base):
        with (
            _HAS_WORKFLOW,
            patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(_FAKE_PROFILE)}),
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_user_profile"),
                _text_response(_json_payload("Your account is fully operational.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat("conv-t1-2", "USR-001", "Why is my account restricted?", category="account_restriction")

        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False

    def test_deposit_issue_turn1_forces_get_user_profile(self, mock_base):
        with (
            _HAS_WORKFLOW,
            patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(_FAKE_PROFILE)}),
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_user_profile"),
                _text_response(_json_payload("Your account looks fine, let me check your deposit.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat("conv-t1-4", "USR-001", "My deposit didn't arrive", category="deposit_issue")

        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False

    def test_trade_issue_turn1_forces_get_user_profile(self, mock_base):
        with (
            _HAS_WORKFLOW,
            patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(_FAKE_PROFILE)}),
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_user_profile"),
                _text_response(_json_payload("Let me check your trading status.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat("conv-t1-5", "USR-001", "My order was not filled", category="trade_issue")

        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False

    def test_kyc_turn1_forces_get_user_profile(self, mock_base):
        with (
            _HAS_WORKFLOW,
            patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(_FAKE_PROFILE)}),
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_user_profile"),
                _text_response(_json_payload("Your KYC is approved.", confidence=0.9)),
            ]
            from engine.agent import chat
            result = chat("conv-t1-3", "USR-001", "What is my KYC status?", category="kyc_verification")

        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False


# ── 3. Turn-2: forced tool disabled (current behavior / known gap) ─────────────

class TestTurn2NoForcedTool:
    """
    After the first successful bot reply (prior_successful_reply=True):
    - Generic messages (no tx_id): no tool is forced — Gemini decides freely.
    - Messages containing a tx_id: get_withdrawal_status is forced regardless of turn.
    """

    def test_no_forced_tool_for_generic_message_after_first_reply(self, mock_base):
        """When no tx_id is present, no tool is forced after the first successful reply."""
        prior_history = [
            {"role": "assistant", "content": _json_payload("Here's what I found about your account.", 0.85)}
        ]
        with (
            patch("engine.agent.get_history", return_value=prior_history),
            patch("db.conversation_store.has_successful_bot_reply", return_value=True),
            _HAS_WORKFLOW,
        ):
            mock_base.models.generate_content.return_value = _text_response(
                _json_payload("I see, can you confirm the amount?", confidence=0.8)
            )
            from engine.agent import chat
            result = chat(
                "conv-t2-1", "USR-001",
                "My withdrawal is still not working",  # no tx_id
                category="withdrawal_issue",
            )

        assert mock_base.models.generate_content.call_count == 1
        assert result.escalated is False

    def test_tx_id_forces_withdrawal_lookup_at_any_turn(self, mock_base):
        """
        When the user mentions a transaction ID at any turn — message 2, 5, 50 — the agent
        is forced to call get_withdrawal_status before replying, regardless of prior replies.
        """
        prior_history = [
            {"role": "assistant", "content": _json_payload("Here's what I found about your account.", 0.85)}
        ]
        with (
            patch("engine.agent.get_history", return_value=prior_history),
            patch("db.conversation_store.has_successful_bot_reply", return_value=True),
            patch("engine.agent.TOOLS", {"get_withdrawal_status": _mock_tool({"transactions": [], "total": 0})}),
            _HAS_WORKFLOW,
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_withdrawal_status"),
                _text_response(_json_payload("I checked that transaction.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat(
                "conv-t2-2", "USR-001",
                "The transaction ID is TXN-9999",
                category="withdrawal_issue",
            )

        # Two Gemini calls: first is forced fn_call, second returns text after tool result
        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False

    def test_tx_id_forces_deposit_lookup_at_any_turn(self, mock_base):
        """
        When the user mentions a transaction ID at any turn in a deposit_issue conversation,
        get_deposit_status is forced regardless of prior replies.
        """
        prior_history = [
            {"role": "assistant", "content": _json_payload("Let me check your deposit.", 0.85)}
        ]
        with (
            patch("engine.agent.get_history", return_value=prior_history),
            patch("db.conversation_store.has_successful_bot_reply", return_value=True),
            patch("engine.agent.TOOLS", {"get_deposit_status": _mock_tool({"transactions": [], "total": 0})}),
            _HAS_WORKFLOW,
        ):
            mock_base.models.generate_content.side_effect = [
                _fn_call_response("get_deposit_status"),
                _text_response(_json_payload("I checked that deposit transaction.", confidence=0.85)),
            ]
            from engine.agent import chat
            result = chat(
                "conv-t2-3", "USR-001",
                "The transaction ID is TXN-9999",
                category="deposit_issue",
            )

        assert mock_base.models.generate_content.call_count == 2
        assert result.escalated is False


# ── 4. Mid-conversation category upgrade ──────────────────────────────────────

class TestCategoryUpgrade:
    """_detect_upgrade only upgrades from 'other'. Specialist categories are locked."""

    def test_upgrade_from_other_to_withdrawal(self):
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("my withdrawal is stuck", "other") == "withdrawal_issue"

    def test_upgrade_from_other_to_kyc(self):
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("I need to complete my KYC verification", "other") == "kyc_verification"

    def test_upgrade_from_other_to_restriction(self):
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("my account is restricted", "other") == "account_restriction"

    def test_no_upgrade_from_withdrawal_issue(self):
        """
        GAP: Once in a specialist category, the user cannot pivot mid-conversation.
        A withdrawal customer who also has a deposit issue cannot be re-routed.
        """
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("my kyc is also pending", "withdrawal_issue") is None

    def test_no_upgrade_from_account_restriction(self):
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("my withdrawal is stuck too", "account_restriction") is None

    def test_no_upgrade_without_keyword_match(self):
        from engine.agent import _detect_upgrade
        assert _detect_upgrade("I have a general question about fees", "other") is None


# ── 5. Stub data — transaction tool gap ──────────────────────────────────────

class TestStubData:
    """
    get_deposit_status and get_withdrawal_status now call the mock store (same pattern
    as get_account_restrictions), returning real transaction data instead of stubs.
    """

    def test_get_deposit_status_returns_real_transactions(self):
        """get_deposit_status returns real mock store data — not a stub."""
        from engine.account_tools import get_deposit_status
        result = get_deposit_status("USR-000001")
        assert "transactions" in result
        assert result["total"] > 0
        first = result["transactions"][0]
        assert first["type"] == "deposit"
        assert first["status"] in ("completed", "pending", "failed", "cancelled")
        assert first["currency"] is not None
        assert first["amount"] is not None

    def test_get_withdrawal_status_returns_real_transactions(self):
        """get_withdrawal_status returns real mock store data — not a stub."""
        from engine.account_tools import get_withdrawal_status
        result = get_withdrawal_status("USR-000001")
        assert "transactions" in result
        assert result["total"] > 0
        first = result["transactions"][0]
        assert first["type"] == "withdrawal"
        assert first["status"] in ("completed", "pending", "failed", "cancelled")

    def test_get_deposit_status_with_valid_tx_id(self):
        """A known tx_id returns that specific transaction."""
        from engine.account_tools import get_deposit_status
        result = get_deposit_status("USR-000001", tx_id="TXN-001-001")
        assert result["transaction_id"] == "TXN-001-001"
        assert result["type"] == "deposit"

    def test_get_deposit_status_with_unknown_tx_id(self):
        """An unknown tx_id returns a not-found error."""
        from engine.account_tools import get_deposit_status
        result = get_deposit_status("USR-000001", tx_id="TXN-DOES-NOT-EXIST")
        assert result.get("error") == "transaction_not_found"

    def test_get_withdrawal_status_with_valid_tx_id(self):
        """A known withdrawal tx_id returns that specific transaction."""
        from engine.account_tools import get_withdrawal_status
        result = get_withdrawal_status("USR-000001", tx_id="TXN-001-004")
        assert result["transaction_id"] == "TXN-001-004"
        assert result["type"] == "withdrawal"
        assert result["status"] == "failed"

    def test_get_account_restrictions_uses_mock_store_not_stub(self):
        """
        Sanity check: get_account_restrictions correctly calls the mock store.
        This is the pattern that deposit/withdrawal should follow.
        """
        from engine.account_tools import get_account_restrictions
        result = get_account_restrictions("USR-000001")
        # Mock store returns a real dict — not a stub. Keys are meaningful.
        assert "has_restrictions" in result
        assert result.get("status") != "stub"


# ── 6. Missing tools in registry ─────────────────────────────────────────────

class TestToolRegistry:
    """
    Trade and balance tools are absent from the tool registry.
    The mock store has rich trade data (spot, futures, transactions) that the agent
    cannot access because no tool bridges it.
    """

    def test_no_spot_trade_tool_registered(self):
        """GAP: No spot order lookup tool — trade issues cannot be investigated."""
        from engine.account_tools import TOOLS
        assert "get_spot_order" not in TOOLS
        assert "get_spot_trades" not in TOOLS

    def test_no_futures_tool_registered(self):
        """GAP: No futures position tool — futures liquidations/losses cannot be investigated."""
        from engine.account_tools import TOOLS
        assert "get_futures_position" not in TOOLS
        assert "get_futures_trades" not in TOOLS

    def test_no_balance_tool_registered(self):
        """GAP: No account balance tool."""
        from engine.account_tools import TOOLS
        assert "get_balance" not in TOOLS

    def test_existing_six_tools_still_registered(self):
        """Sanity check: the 6 current tools are still in the registry."""
        from engine.account_tools import TOOLS
        expected = {
            "get_user_profile", "get_kyc_status",
            "get_deposit_status", "get_withdrawal_status",
            "get_account_restrictions", "get_trading_availability",
        }
        assert expected.issubset(TOOLS.keys())
