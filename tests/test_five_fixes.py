"""
Behavioral simulation tests for the 5 post-escalation fixes.
Uses the same mock infrastructure as test_agent_investigation_baseline.py.
"""
import json
from unittest.mock import MagicMock, patch, call

import pytest


def _text_response(text):
    part = MagicMock(); part.text = text; part.function_call = None
    content = MagicMock(); content.parts = [part]
    candidate = MagicMock(); candidate.content = content
    resp = MagicMock(); resp.candidates = [candidate]
    return resp


def _fn_call_response(tool_name, args=None):
    fn_call = MagicMock(); fn_call.name = tool_name; fn_call.args = args or {}
    fn_part = MagicMock(); fn_part.function_call = fn_call; fn_part.text = None
    content = MagicMock(); content.parts = [fn_part]
    candidate = MagicMock(); candidate.content = content
    resp = MagicMock(); resp.candidates = [candidate]
    return resp


def _json(response, confidence=0.85, needs_human=False):
    return json.dumps({"response": response, "confidence": confidence,
                       "needs_human": needs_human, "resolved": False})


def _mock_tool(result):
    return lambda user_id=None, **kw: result


def _get_system_prompt_from_call(mock_client, call_index=0):
    """Extract system_instruction from the config kwarg of generate_content call N."""
    calls = mock_client.models.generate_content.call_args_list
    if call_index >= len(calls):
        return ""
    cfg = calls[call_index].kwargs.get("config")
    return getattr(cfg, "system_instruction", "") or ""


def _get_tools_from_call(mock_client, call_index=0):
    """Extract tools list from the config kwarg of generate_content call N."""
    calls = mock_client.models.generate_content.call_args_list
    if call_index >= len(calls):
        return None
    cfg = calls[call_index].kwargs.get("config")
    return getattr(cfg, "tools", None) if cfg else None


def _get_fn_response_result(mock_client, call_index=1):
    """Extract the function_response result dict from generate_content call N.

    Skips MagicMock function_response attributes (from mock tool-call parts) and
    only returns from real genai_types.FunctionResponse objects — identified by
    having a real dict as their .response attribute.
    """
    calls = mock_client.models.generate_content.call_args_list
    if call_index >= len(calls):
        return {}
    contents = calls[call_index].kwargs.get("contents", [])
    for content in contents:
        if hasattr(content, "parts"):
            for part in content.parts:
                fr = getattr(part, "function_response", None)
                if fr and isinstance(getattr(fr, "response", None), dict):
                    return fr.response.get("result", {})
    return {}


@pytest.fixture(autouse=True)
def mock_base():
    with (
        patch("engine.agent.client") as mock_client,
        patch("engine.agent.get_history", return_value=[]),
        patch("engine.agent.collection_count", return_value=0),
        patch("engine.agent.retrieve_with_fallback", return_value=[]),
        patch("engine.agent.get_ticket_id_by_conversation", return_value="t-fix"),
        patch("engine.agent.update_ticket_status"),
        patch("engine.agent.get_ticket_meta", return_value={"priority": 3, "customer_id": "c-1"}),
        patch("engine.agent.get_ai_persona", return_value={"name": "Aria", "avatar": None, "avatar_url": None}),
        patch("engine.agent.update_customer_from_profile"),
        patch("engine.agent.add_message"),
        patch("db.conversation_store.is_human_handling", return_value=False),
        patch("db.conversation_store.has_successful_bot_reply", return_value=False),
        patch("workflow_engine.store.get_published_workflows_by_trigger",
              return_value=[{"id": "wf-1", "name": "wf", "published": True,
                             "trigger": {"channel": "widget", "category": "any"}}]),
    ):
        yield mock_client


# ── Issue 5: No re-introduction on follow-up turns ───────────────

class TestNoReintroductionOnFollowUp:

    def test_first_turn_no_marker(self, mock_base):
        """Turn 1: empty history → system prompt has NO follow-up marker."""
        mock_base.models.generate_content.return_value = _text_response(_json("Your KYC is pending."))

        from engine.agent import chat
        chat("conv-5a", "u1", "what is my KYC status?", category="kyc_verification")

        prompt = _get_system_prompt_from_call(mock_base)
        assert mock_base.models.generate_content.called
        assert "Do NOT introduce yourself" not in prompt, \
            "Follow-up marker must NOT appear on first turn (empty history)"

    def test_followup_turn_has_marker(self, mock_base):
        """Turn 2+: non-empty history → system prompt includes the no-intro marker."""
        mock_base.models.generate_content.return_value = _text_response(_json("You're welcome!"))

        prior = [
            {"role": "user", "content": "what is my KYC status?"},
            {"role": "assistant", "content": _json("Your KYC is pending.")},
            {"role": "user", "content": "ok thanks"},
        ]
        with patch("engine.agent.get_history", return_value=prior):
            from engine.agent import chat
            chat("conv-5b", "u1", "ok thanks", category="kyc_verification")

        prompt = _get_system_prompt_from_call(mock_base)
        assert "Do NOT introduce yourself" in prompt, \
            "Follow-up marker MUST be present when history is non-empty"


# ── Issue 2: Null reason fields sanitized before reaching Gemini ──

class TestNullFieldSanitization:

    def test_null_rejection_reason_becomes_marker(self, mock_base):
        """
        When get_user_profile returns rejection_reason=None,
        the function_response sent to Gemini on the second call
        must contain the explicit do-not-guess marker.
        """
        kyc_null = {
            "user_id": "u1", "first_name": "Somchai",
            "kyc": {"status": "rejected", "rejection_reason": None, "reviewed_at": "2026-05-30"}
        }
        mock_base.models.generate_content.side_effect = [
            _fn_call_response("get_user_profile"),
            _text_response(_json("Reason is under review.")),
        ]
        with patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(kyc_null)}):
            from engine.agent import chat
            chat("conv-2a", "u1", "why was my KYC rejected?", category="kyc_verification")

        result = _get_fn_response_result(mock_base, call_index=1)
        kyc = result.get("kyc", {})
        assert kyc.get("rejection_reason") == "[NOT PROVIDED — do not guess or infer this value]", \
            f"Expected marker, got: {kyc.get('rejection_reason')!r}"

    def test_reviewed_at_date_not_sanitized(self, mock_base):
        """reviewed_at is a date — must NOT be replaced with the marker."""
        kyc_null = {
            "user_id": "u1",
            "kyc": {"status": "rejected", "rejection_reason": None, "reviewed_at": "2026-05-30"}
        }
        mock_base.models.generate_content.side_effect = [
            _fn_call_response("get_user_profile"),
            _text_response(_json("Reason under review.")),
        ]
        with patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(kyc_null)}):
            from engine.agent import chat
            chat("conv-2b", "u1", "why was my KYC rejected?", category="kyc_verification")

        result = _get_fn_response_result(mock_base, call_index=1)
        assert result.get("kyc", {}).get("reviewed_at") == "2026-05-30", \
            f"reviewed_at should be '2026-05-30', got: {result.get('kyc', {}).get('reviewed_at')!r}"

    def test_non_null_reason_unchanged(self, mock_base):
        """A real rejection_reason must pass through to Gemini unchanged."""
        kyc_real = {
            "user_id": "u1",
            "kyc": {"status": "rejected", "rejection_reason": "ID image was blurry", "reviewed_at": "2026-05-30"}
        }
        mock_base.models.generate_content.side_effect = [
            _fn_call_response("get_user_profile"),
            _text_response(_json("Your ID was blurry — please resubmit.")),
        ]
        with patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(kyc_real)}):
            from engine.agent import chat
            chat("conv-2c", "u1", "why was my KYC rejected?", category="kyc_verification")

        result = _get_fn_response_result(mock_base, call_index=1)
        assert result.get("kyc", {}).get("rejection_reason") == "ID image was blurry", \
            f"Non-null reason must be unchanged, got: {result.get('kyc', {}).get('rejection_reason')!r}"

    def test_null_restriction_reason_in_nested_list(self, mock_base):
        """restriction_reason=None inside a nested list of restrictions is also sanitized."""
        restrictions = {
            "user_id": "u1",
            "has_restrictions": True,
            "restrictions": [{"type": "withdrawal_block", "restriction_reason": None, "expected_lift_at": "2026-07-01"}]
        }
        mock_base.models.generate_content.side_effect = [
            _fn_call_response("get_account_restrictions"),
            _text_response(_json("Restriction reason is under review.")),
        ]
        with patch("engine.agent.TOOLS", {"get_account_restrictions": _mock_tool(restrictions)}):
            from engine.agent import chat
            chat("conv-2d", "u1", "why is my account restricted?", category="account_restriction")

        result = _get_fn_response_result(mock_base, call_index=1)
        restrictions_out = result.get("restrictions", [{}])
        if restrictions_out:
            assert restrictions_out[0].get("restriction_reason") == \
                "[NOT PROVIDED — do not guess or infer this value]", \
                f"Got: {restrictions_out[0].get('restriction_reason')!r}"
            # expected_lift_at is a date — must not be sanitized
            assert restrictions_out[0].get("expected_lift_at") == "2026-07-01", \
                f"expected_lift_at must be unchanged, got: {restrictions_out[0].get('expected_lift_at')!r}"


# ── Issue 4: Tools always present for authenticated sessions ──────

class TestToolsAlwaysAvailable:

    def test_informational_withdrawal_question_has_tools(self, mock_base):
        """
        'What are the withdrawal fees?' is informational — but tools are still
        provided to Gemini. STEP 0 inside the overlay tells Gemini not to call them.
        (Previously the classifier would strip tools before this message reached Gemini.)
        """
        mock_base.models.generate_content.return_value = _text_response(_json("Fees are 0.001 BTC."))
        from engine.agent import chat
        chat("conv-4a", "u1", "what are the withdrawal fees?", category="withdrawal_issue")

        tools = _get_tools_from_call(mock_base)
        assert tools, "Tools must be present in Gemini call even for informational questions"

    def test_account_specific_kyc_has_tools(self, mock_base):
        """Account-specific question must always get tools."""
        mock_base.models.generate_content.return_value = _text_response(_json("Checking your KYC."))
        from engine.agent import chat
        chat("conv-4b", "u1", "why was my KYC rejected?", category="kyc_verification")

        tools = _get_tools_from_call(mock_base)
        assert tools, "Tools must be present for account-specific questions"

    def test_guest_session_no_tools(self, mock_base):
        """Guest session (user_id=None) must never get tools."""
        mock_base.models.generate_content.return_value = _text_response(_json("Here is general info."))
        from engine.agent import chat
        chat("conv-4c", None, "what are the fees?", category="withdrawal_issue")

        tools = _get_tools_from_call(mock_base)
        assert not tools, "Guest sessions must never have tools"

    def test_other_category_no_tools(self, mock_base):
        """'other' category must never get tools."""
        mock_base.models.generate_content.return_value = _text_response(_json("Let me help."))
        from engine.agent import chat
        chat("conv-4d", "u1", "general question", category="other")

        tools = _get_tools_from_call(mock_base)
        assert not tools, "'other' category must have no tools"


# ── Issue 1: RAG retrieve_with_fallback called when KB has docs ───

class TestRAGRetrieval:

    def test_retrieve_called_when_kb_nonempty(self, mock_base):
        """retrieve_with_fallback is called when collection_count > 0."""
        mock_base.models.generate_content.return_value = _text_response(_json("Fees are 0.001 BTC."))

        with (
            patch("engine.agent.collection_count", return_value=10),
            patch("engine.agent.retrieve_with_fallback", return_value=[
                {"text": "Fee is 0.001 BTC.", "metadata": {"doc_type": "documentation"}, "distance": 0.28}
            ]) as mock_retrieve,
        ):
            from engine.agent import chat
            chat("conv-1a", "u1", "what are the withdrawal fees?", category="withdrawal_issue")

        mock_retrieve.assert_called_once()

    def test_retrieve_not_called_when_kb_empty(self, mock_base):
        """retrieve_with_fallback is NOT called when collection_count == 0."""
        mock_base.models.generate_content.return_value = _text_response(_json("Fees are 0.001 BTC."))

        with (
            patch("engine.agent.collection_count", return_value=0),
            patch("engine.agent.retrieve_with_fallback", return_value=[]) as mock_retrieve,
        ):
            from engine.agent import chat
            chat("conv-1b", "u1", "what are the withdrawal fees?", category="withdrawal_issue")

        mock_retrieve.assert_not_called()
