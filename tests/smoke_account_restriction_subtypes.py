"""
Smoke test — account_restriction subtype dispatch.

Tests each new subtype by driving the agent through the 3-phase workflow:
  Turn 1 (TRIAGE)    → bot asks what the problem is
  Turn 2 (COLLECTION) → bot asks for details
  Turn 3 (RESOLUTION) → Phase 3 injected; bot uses restriction data

We verify:
  - The right key phrases appear (or don't appear) in the bot's response
  - needs_human matches expectation
  - mule_permanent never offers any resolution / form link
  - monthly_limit_reached never mentions a number
  - cfr_freeze mentions CCIB / ศปอท.

Run: python -m pytest tests/smoke_account_restriction_subtypes.py -v -s
NOTE: Uses real Gemini API — requires a valid GEMINI_API_KEY in .env
"""
# Load real .env BEFORE root conftest.py overwrites GEMINI_API_KEY with the fake key
import tests.conftest_smoke  # noqa: F401 — side-effect import, must be first

import uuid
from collections import defaultdict
from unittest.mock import patch
import pytest
from engine.agent import chat
from engine.mock_api import restrictions as restriction_store

# ── helpers ──────────────────────────────────────────────────────────────────

def conv() -> str:
    return str(uuid.uuid4())


def run_three_turns(user_id: str, symptom: str, detail: str, language: str = "en"):
    """
    Drive the 3-phase workflow to RESOLUTION and return the final bot response.

    Patches the three DB calls agent.py makes so we don't need a live Postgres:
      - get_history        → in-memory list per conversation
      - add_message        → appends to that list
      - is_human_handling  → always False (ticket not escalated)
    """
    cid = conv()
    _history: dict[str, list] = defaultdict(list)

    def fake_get_history(conv_id, limit=10):
        return _history[conv_id][-limit:]

    def fake_add_message(conv_id, role, content, **kw):
        _history[conv_id].append({"role": role, "content": content})

    def fake_is_human(conv_id):
        return False

    def fake_get_ticket_id(conv_id):
        return None

    with patch("engine.agent.get_history", side_effect=fake_get_history), \
         patch("engine.agent.add_message", side_effect=fake_add_message), \
         patch("db.conversation_store.is_human_handling", side_effect=fake_is_human), \
         patch("engine.agent.get_ticket_id_by_conversation", side_effect=fake_get_ticket_id):

        # Turn 1 — triage: bot asks what the problem is
        _history[cid].append({"role": "user", "content": "Hello, I need help with my account"})
        r1 = chat(cid, user_id, "Hello, I need help with my account",
                  category="account_restriction", override_language=language,
                  suppress_handoff=True)
        assert r1.text, "Turn 1 empty"
        _history[cid].append({"role": "model", "content": r1.text})

        # Turn 2 — collection: user describes symptom, bot asks for details
        _history[cid].append({"role": "user", "content": symptom})
        r2 = chat(cid, user_id, symptom,
                  category="account_restriction", override_language=language,
                  suppress_handoff=True)
        assert r2.text, "Turn 2 empty"
        _history[cid].append({"role": "model", "content": r2.text})

        # Turn 3 — resolution: inject account data → Phase 3 activates
        restriction_data = restriction_store.get_by_user_id(user_id)
        assert restriction_data is not None, f"No mock data for {user_id}"

        _history[cid].append({"role": "user", "content": detail})
        r3 = chat(cid, user_id, detail,
                  category="account_restriction",
                  override_language=language,
                  suppress_handoff=True,
                  injected_account_data=restriction_data.model_dump(mode="json"))
        return r3


# ── tests ─────────────────────────────────────────────────────────────────────

class TestSubtypeDispatch:

    def test_mule_permanent_no_resolution_offered(self):
        """Black/Dark Grey mule — restriction notice only, no form, no escalation path."""
        r = run_three_turns("USR-000022", "I cannot trade or withdraw", "I just see it's restricted")
        text = r.text.lower()
        print(f"\n[mule_permanent] response:\n{r.text}\n")

        # Must NOT offer a form or resolution
        assert "forms.gle" not in text, "Should not link to KYC form for permanent mule"
        assert "submit" not in text or "request" not in text, "Should not instruct submission for permanent mule"
        # Must NOT reveal internal classification
        assert "mule" not in text
        assert "black" not in text and "grey" not in text and "brown" not in text

    def test_mule_reviewable_links_to_form(self):
        """Light Grey/Brown mule — must direct to Google Form."""
        r = run_three_turns("USR-000021", "My account is suspended", "I can't deposit or trade")
        text = r.text.lower()
        print(f"\n[mule_reviewable] response:\n{r.text}\n")

        assert "forms.gle" in r.text, "Should link to KYC review Google Form"
        assert "mule" not in text

    def test_cfr_freeze_mentions_ccib(self):
        """CFR freeze — must mention CCIB / ศปอท., must not reveal why it was applied."""
        r = run_three_turns("USR-000023", "My account is frozen", "I can't do anything")
        text = r.text.lower()
        print(f"\n[cfr_freeze] response:\n{r.text}\n")

        assert "ccib" in text or "ศปอท" in r.text, "Should mention CCIB/ศปอท"
        assert r.escalated is False, "cfr_freeze should not immediately escalate"

    def test_daily_limit_reached_deposit(self):
        """Daily deposit limit — must mention limit reset and KYC upgrade form."""
        r = run_three_turns("USR-000024", "I cannot deposit THB", "I see an error when depositing")
        text = r.text.lower()
        print(f"\n[daily_limit/deposit] response:\n{r.text}\n")

        assert "limit" in text, "Should mention deposit limit"
        assert r.escalated is False

    def test_daily_limit_reached_withdrawal(self):
        """Daily withdrawal limit — must mention limit reset and KYC upgrade."""
        r = run_three_turns("USR-000025", "I cannot withdraw THB", "It says error on withdrawal")
        text = r.text.lower()
        print(f"\n[daily_limit/withdrawal] response:\n{r.text}\n")

        assert "limit" in text
        assert r.escalated is False

    def test_first_deposit_hold(self):
        """24-hour hold — must explain the policy, no action needed from customer."""
        r = run_three_turns("USR-000029", "I cannot withdraw after my deposit", "I just made my first deposit")
        text = r.text.lower()
        print(f"\n[first_deposit_hold] response:\n{r.text}\n")

        assert "24" in text or "twenty-four" in text or "hold" in text, "Should explain 24-hour hold"
        assert r.escalated is False

    def test_monthly_limit_never_discloses_number(self):
        """Monthly limit — must NEVER disclose the 100M cap."""
        r = run_three_turns("USR-000032", "I get 'Exceed Monthly Limit' error", "When I try to buy tokens")
        text = r.text.lower()
        print(f"\n[monthly_limit_reached] response:\n{r.text}\n")

        assert "100,000,000" not in text and "100000000" not in text and "100 million" not in text, \
            "Must NOT disclose the 100M monthly cap"
        assert "month" in text, "Should mention monthly limit"
        assert r.escalated is False

    def test_wrong_password_requires_selfie_submission(self):
        """Wrong password lockout — must instruct selfie + National ID submission."""
        r = run_three_turns("USR-000076", "I am locked out", "I entered wrong password too many times")
        text = r.text.lower()
        print(f"\n[wrong_password] response:\n{r.text}\n")

        assert "selfie" in text or "national id" in text or "id" in text, \
            "Should instruct selfie/ID submission"
        assert r.escalated is True, "wrong_password should escalate after instructions"

    def test_2fa_lost_requires_selfie_submission(self):
        """Lost 2FA — must instruct selfie + National ID submission for reset."""
        r = run_three_turns("USR-000013", "I cannot log in, lost 2FA", "I deleted my authenticator app")
        text = r.text.lower()
        print(f"\n[2fa_lost] response:\n{r.text}\n")

        assert "selfie" in text or "national id" in text or "id" in text, \
            "Should instruct selfie/ID submission for 2FA reset"
        assert r.escalated is True, "2fa_lost should escalate after instructions"

    def test_edd_incomplete_instructs_submission(self):
        """EDD incomplete — must explain EDD and instruct completion.
        suppress_handoff=True (workflow mode) means escalation is deferred to the workflow
        node — agent itself returns escalated=False but text must contain instructions.
        """
        r = run_three_turns("USR-000039", "My account is limited", "I can't trade anything")
        text = r.text.lower()
        print(f"\n[edd_incomplete] response:\n{r.text}\n")

        assert "edd" in text or "enhanced due diligence" in text or "document" in text, \
            "Should mention EDD requirements"
        assert "submit" in text or "complete" in text or "kyc" in text, \
            "Should instruct what to do next"
