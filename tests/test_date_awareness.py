"""
Tests for three date-awareness and Phase 2 fixes:

  Fix 1 — current_date injected into every build_user_message() call
  Fix 2 — Overdue expected_lift_at rule present in base system prompts (EN + TH)
  Fix 3 — Phase 2 prohibition present in all category overlays (EN + TH)
"""
import json
import re
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

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


def _json(response, confidence=0.85, needs_human=False, resolved=False):
    return json.dumps({
        "response": response, "confidence": confidence,
        "needs_human": needs_human, "resolved": resolved,
        "quick_replies": [],
    })


def _mock_tool(result):
    return lambda user_id=None, **kw: result


def _get_last_user_text(mock_client, call_index=0):
    calls = mock_client.models.generate_content.call_args_list
    if call_index >= len(calls):
        return ""
    contents = calls[call_index].kwargs.get("contents", [])
    for content in reversed(contents):
        if getattr(content, "role", None) == "user":
            for part in getattr(content, "parts", []):
                text = getattr(part, "text", None)
                if text:
                    return text
    return ""


def _get_system_prompt_from_call(mock_client, call_index=0):
    calls = mock_client.models.generate_content.call_args_list
    if call_index >= len(calls):
        return ""
    cfg = calls[call_index].kwargs.get("config")
    return getattr(cfg, "system_instruction", "") or ""


@pytest.fixture(autouse=True)
def mock_base():
    with (
        patch("engine.agent.client") as mock_client,
        patch("engine.agent.get_history", return_value=[]),
        patch("engine.agent.collection_count", return_value=0),
        patch("engine.agent.retrieve_with_fallback", return_value=[]),
        patch("engine.agent.get_ticket_id_by_conversation", return_value="t-date"),
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


class TestCurrentDateInjection:
    def test_current_date_is_first_line(self):
        from engine.prompt_templates import build_user_message
        result = build_user_message("hello", [], {})
        first_line = result.split("\n")[0]
        assert first_line.startswith("current_date: ")

    def test_current_date_format_is_iso(self):
        from engine.prompt_templates import build_user_message
        result = build_user_message("hello", [], {})
        date_str = result.split("\n")[0].replace("current_date: ", "")
        assert re.match(r"^\d{4}-\d{2}-\d{2}$", date_str)

    def test_current_date_matches_today_utc(self):
        from engine.prompt_templates import build_user_message
        result = build_user_message("hello", [], {})
        date_str = result.split("\n")[0].replace("current_date: ", "")
        assert date_str == datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def test_current_date_present_with_rag_chunks(self):
        from engine.prompt_templates import build_user_message
        chunks = [{"text": "Fee is 0.001 BTC.", "metadata": {"source": "docs"}, "distance": 0.3}]
        result = build_user_message("fees?", chunks, {})
        assert result.split("\n")[0].startswith("current_date: ")

    def test_current_date_present_with_account_data(self):
        from engine.prompt_templates import build_user_message
        result = build_user_message("kyc?", [], {"kyc": {"status": "pending_review"}})
        assert result.split("\n")[0].startswith("current_date: ")

    def test_current_date_present_with_both_rag_and_account_data(self):
        from engine.prompt_templates import build_user_message
        chunks = [{"text": "KB text.", "metadata": {"source": "docs"}, "distance": 0.2}]
        account = {"restrictions": [{"expected_lift_at": "2026-04-03"}]}
        result = build_user_message("blocked?", chunks, account)
        assert result.split("\n")[0].startswith("current_date: ")

    def test_current_date_reaches_gemini(self, mock_base):
        mock_base.models.generate_content.return_value = _text_response(_json("KYC pending."))
        from engine.agent import chat
        chat("conv-date-1", "u1", "what is my KYC status?", category="kyc_verification")
        user_text = _get_last_user_text(mock_base)
        assert "current_date:" in user_text

    def test_current_date_reaches_gemini_for_every_category(self, mock_base):
        for cat in ["kyc_verification", "account_restriction", "withdrawal_issue",
                    "deposit_issue", "trade_issue", "other"]:
            mock_base.reset_mock()
            mock_base.models.generate_content.return_value = _text_response(_json(f"Handling {cat}."))
            from engine.agent import chat
            chat(f"conv-date-{cat}", "u1", "I have an issue", category=cat)
            user_text = _get_last_user_text(mock_base)
            assert "current_date:" in user_text, f"current_date missing for category '{cat}'"

    def test_current_date_reaches_gemini_after_tool_call(self, mock_base):
        profile = {"user_id": "u1", "kyc": {"status": "pending_review", "rejection_reason": None}}
        mock_base.models.generate_content.side_effect = [
            _fn_call_response("get_user_profile"),
            _text_response(_json("KYC is pending.")),
        ]
        with patch("engine.agent.TOOLS", {"get_user_profile": _mock_tool(profile)}):
            from engine.agent import chat
            chat("conv-date-tool", "u1", "what is my kyc?", category="kyc_verification")
        assert mock_base.models.generate_content.call_count >= 2
        assert "current_date:" in _get_last_user_text(mock_base, call_index=0)


class TestOverdueDateRule:
    def test_overdue_rule_present_in_en_base_prompt(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "expected_lift_at" in SYSTEM_PROMPTS["en"]
        assert "current_date" in SYSTEM_PROMPTS["en"]

    def test_overdue_rule_present_in_th_base_prompt(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "expected_lift_at" in SYSTEM_PROMPTS["th"]
        assert "current_date" in SYSTEM_PROMPTS["th"]

    def test_overdue_rule_instructs_needs_human_en(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "needs_human=true" in SYSTEM_PROMPTS["en"]

    def test_overdue_rule_instructs_needs_human_th(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "needs_human=true" in SYSTEM_PROMPTS["th"]

    def test_overdue_rule_forbids_quoting_past_date_as_future_en(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "Do NOT quote it as if it is a future date" in SYSTEM_PROMPTS["en"]

    def test_overdue_rule_forbids_arguing_about_date_en(self):
        from engine.prompt_templates import SYSTEM_PROMPTS
        assert "Never argue with the customer about what today" in SYSTEM_PROMPTS["en"]

    def test_overdue_rule_in_system_prompt_sent_to_gemini(self, mock_base):
        mock_base.models.generate_content.return_value = _text_response(_json("Restriction active."))
        from engine.agent import chat
        chat("conv-overdue-1", "u1", "when will my block lift?", category="account_restriction")
        sp = _get_system_prompt_from_call(mock_base)
        assert "expected_lift_at" in sp
        assert "current_date" in sp

    @pytest.mark.parametrize("category", [
        "kyc_verification", "account_restriction",
        "withdrawal_issue", "deposit_issue", "trade_issue",
    ])
    def test_overdue_rule_present_for_all_account_categories(self, mock_base, category):
        mock_base.models.generate_content.return_value = _text_response(_json(f"Handling {category}."))
        from engine.agent import chat
        chat(f"conv-overdue-{category}", "u1", "status?", category=category)
        sp = _get_system_prompt_from_call(mock_base)
        assert "expected_lift_at" in sp, f"expected_lift_at rule missing for '{category}'"
        assert "current_date" in sp, f"current_date reference missing for '{category}'"


class TestPhase2Prohibition:
    @pytest.mark.parametrize("category", [
        "kyc_verification", "account_restriction",
        "withdrawal_issue", "deposit_issue", "trade_issue",
    ])
    def test_prohibition_in_en_overlay(self, category):
        from engine.prompt_templates import CATEGORY_OVERLAYS
        assert "intentionally deferred to Phase 3" in CATEGORY_OVERLAYS[category]["en"], (
            f"EN Phase 2 prohibition missing for '{category}'"
        )

    @pytest.mark.parametrize("category", [
        "kyc_verification", "account_restriction",
        "withdrawal_issue", "deposit_issue", "trade_issue",
    ])
    def test_prohibition_in_th_overlay(self, category):
        from engine.prompt_templates import CATEGORY_OVERLAYS
        assert "เลื่อนไปยังเฟส 3 โดยตั้งใจ" in CATEGORY_OVERLAYS[category]["th"], (
            f"TH Phase 2 prohibition missing for '{category}'"
        )

    @pytest.mark.parametrize("category", [
        "kyc_verification", "account_restriction",
        "withdrawal_issue", "deposit_issue", "trade_issue",
    ])
    def test_prohibition_is_inside_phase2_block_en(self, category):
        from engine.prompt_templates import CATEGORY_OVERLAYS
        overlay = CATEGORY_OVERLAYS[category]["en"]
        # Use "PHASE N —" to match only section headers, not inline refs like "--- PHASE 3 ACTIVE"
        p2 = overlay.find("PHASE 2 —")
        p3 = overlay.find("PHASE 3 —")
        assert p2 != -1 and p3 != -1
        assert "intentionally deferred to Phase 3" in overlay[p2:p3], (
            f"'{category}' EN: prohibition must be inside PHASE 2 block"
        )

    @pytest.mark.parametrize("category", [
        "kyc_verification", "account_restriction",
        "withdrawal_issue", "deposit_issue", "trade_issue",
    ])
    def test_prohibition_reaches_gemini_system_prompt(self, mock_base, category):
        mock_base.models.generate_content.return_value = _text_response(_json("More details?"))
        from engine.agent import chat
        chat(f"conv-p2-{category}", "u1", "I have an issue", category=category)
        sp = _get_system_prompt_from_call(mock_base)
        assert "intentionally deferred to Phase 3" in sp, (
            f"Phase 2 prohibition must reach Gemini for '{category}'"
        )


class TestMockDataSanity:
    def test_dev_user_lift_date_is_future(self):
        from engine.mock_api.restrictions import get_by_user_id
        dev = get_by_user_id("dev_user")
        assert dev is not None
        lift = dev.restrictions[0].expected_lift_at
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        assert lift > today, f"dev_user lift date '{lift}' must be after today '{today}'"

    def test_usr_000019_is_overdue_test_case(self):
        from engine.mock_api.restrictions import get_by_user_id
        u19 = get_by_user_id("USR-000019")
        assert u19 is not None
        lift = u19.restrictions[0].expected_lift_at
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        assert lift < today, f"USR-000019 must remain an overdue test case (lift '{lift}' < today '{today}')"
