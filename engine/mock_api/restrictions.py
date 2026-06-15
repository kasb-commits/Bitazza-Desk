"""
Mock account restriction data — covers all 101 mock users (dev_user + USR-000001–000100).

Scenario coverage (original 20):
  • No restrictions       : USR-000001–000004, USR-000014
  • withdrawal_block      : USR-000005, USR-000006, USR-000011, USR-000017, dev_user
  • trading_block         : USR-000007, USR-000012, USR-000018
  • deposit_block         : USR-000008, USR-000019
  • full_freeze (AML/comp) : USR-000009, USR-000010, USR-000015, USR-000016, USR-000020
  • login_block            : USR-000013 (2fa_lost), USR-000076 (wrong_password), USR-000082 (wrong_password)
  • can_self_resolve=True  : USR-000011, USR-000017 (expired KYC), USR-000013 (2fa_lost)

New subtype scenarios:
  • full_freeze/mule_reviewable  : USR-000021
  • full_freeze/mule_permanent   : USR-000022
  • full_freeze/cfr_freeze       : USR-000023
  • deposit_block/daily_limit    : USR-000024
  • withdrawal_block/daily_limit : USR-000025
  • withdrawal_block/first_deposit_hold : USR-000029
  • trading_block/monthly_limit  : USR-000032
  • trading_block/edd_incomplete : USR-000039 (updated)

Simulation pool (USR-000021–100, ~25 users with restrictions):
  • withdrawal_block      : USR-000026, USR-000030, USR-000034, USR-000042, USR-000046,
                            USR-000052, USR-000058, USR-000062, USR-000068, USR-000095
  • trading_block         : USR-000027, USR-000033, USR-000039, USR-000063, USR-000071
  • full_freeze           : USR-000028, USR-000035, USR-000043, USR-000088
  • deposit_block         : USR-000031, USR-000037, USR-000047, USR-000061
  • login_block           : USR-000076, USR-000082
"""
from engine.mock_api.models import (
    AccountRestriction,
    AccountRestrictionsResponse,
    RestrictionType,
    RestrictionStatus,
)

# ── Seed data ─────────────────────────────────────────────────────────────────

_SEED: list[dict] = [
    # ── dev_user: withdrawal blocked — easy local testing ────────────────────
    {
        "user_id": "dev_user",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-DEV-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal temporarily blocked pending identity re-verification.",
                applied_at="2026-03-28T10:00:00Z",
                expected_lift_at="2026-08-01T10:00:00Z",
                can_self_resolve=True,
                resolution_steps=(
                    "Please update your ID document in the KYC section of your profile. "
                    "Withdrawals will be re-enabled within 24 hours of approval."
                ),
            )
        ],
    },

    # ── No restrictions ───────────────────────────────────────────────────────
    {"user_id": "USR-000001", "restrictions": []},
    {"user_id": "USR-000002", "restrictions": []},
    {"user_id": "USR-000003", "restrictions": []},
    {"user_id": "USR-000004", "restrictions": []},
    {"user_id": "USR-000014", "restrictions": []},

    # ── Mule account — reviewable (Light Grey / Brown tier) ──────────────────
    {
        "user_id": "USR-000021",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000021-001",
                type=RestrictionType.full_freeze,
                subtype="mule_reviewable",
                status=RestrictionStatus.active,
                reason="Your account has been restricted pending a compliance review. You may submit information for review.",
                applied_at="2026-05-10T09:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Please complete the KYC compliance review form at: "
                    "https://forms.gle/N5v2hFAKaA3f3JiS6 — our Compliance/KYC team will "
                    "review your submission and contact you with next steps."
                ),
            )
        ],
    },

    # ── Mule account — permanent (Black / Dark Grey tier) ────────────────────
    {
        "user_id": "USR-000022",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000022-001",
                type=RestrictionType.full_freeze,
                subtype="mule_permanent",
                status=RestrictionStatus.active,
                reason="Your account has been permanently restricted.",
                applied_at="2026-04-15T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },

    # ── CFR freeze — 4-day legal hold ────────────────────────────────────────
    {
        "user_id": "USR-000023",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000023-001",
                type=RestrictionType.full_freeze,
                subtype="cfr_freeze",
                status=RestrictionStatus.active,
                reason="Your account has been temporarily suspended under the 2023 Royal Decree pending receipt of an official order.",
                applied_at="2026-06-10T08:00:00Z",
                expected_lift_at="2026-06-14T08:00:00Z",
                can_self_resolve=False,
            )
        ],
    },

    # ── Daily fiat deposit limit reached ─────────────────────────────────────
    {
        "user_id": "USR-000024",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000024-001",
                type=RestrictionType.deposit_block,
                subtype="daily_limit_reached",
                status=RestrictionStatus.active,
                reason="You have reached your daily THB deposit limit for your current KYC tier.",
                applied_at="2026-06-11T00:00:00Z",
                expected_lift_at="2026-06-12T00:00:00Z",
                can_self_resolve=True,
                resolution_steps=(
                    "To increase your daily deposit limit, upgrade your KYC tier by submitting "
                    "your information at: https://docs.google.com/forms/d/e/"
                    "1FAIpQLSdn9jGmWV497bWdggqlIINyFiUPCkaeMNsaEPBtvd7ltf6e4A/viewform — "
                    "our KYC team will review and increase your tier accordingly. "
                    "Alternatively, your current daily limit resets at midnight."
                ),
            )
        ],
    },

    # ── Daily fiat withdrawal limit reached ───────────────────────────────────
    {
        "user_id": "USR-000025",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000025-001",
                type=RestrictionType.withdrawal_block,
                subtype="daily_limit_reached",
                status=RestrictionStatus.active,
                reason="You have reached your daily THB withdrawal limit for your current KYC tier.",
                applied_at="2026-06-11T00:00:00Z",
                expected_lift_at="2026-06-12T00:00:00Z",
                can_self_resolve=True,
                resolution_steps=(
                    "To increase your daily withdrawal limit, upgrade your KYC tier by submitting "
                    "your information at: https://docs.google.com/forms/d/e/"
                    "1FAIpQLSdn9jGmWV497bWdggqlIINyFiUPCkaeMNsaEPBtvd7ltf6e4A/viewform — "
                    "our KYC team will review and increase your tier accordingly. "
                    "Alternatively, your current daily limit resets at midnight."
                ),
            )
        ],
    },

    # ── First-time THB deposit 24-hour hold ───────────────────────────────────
    {
        "user_id": "USR-000029",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000029-001",
                type=RestrictionType.withdrawal_block,
                subtype="first_deposit_hold",
                status=RestrictionStatus.active,
                reason="A 24-hour security hold has been applied following your first THB deposit. All fiat and crypto withdrawals are paused until the hold expires.",
                applied_at="2026-06-11T06:00:00Z",
                expected_lift_at="2026-06-12T06:00:00Z",
                can_self_resolve=False,
            )
        ],
    },

    # ── Monthly token trading limit reached ───────────────────────────────────
    {
        "user_id": "USR-000032",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000032-001",
                type=RestrictionType.trading_block,
                subtype="monthly_limit_reached",
                status=RestrictionStatus.active,
                reason="You have reached the monthly trading threshold for this token on your current KYC tier.",
                applied_at="2026-06-11T00:00:00Z",
                expected_lift_at="2026-07-01T00:00:00Z",
                can_self_resolve=True,
                resolution_steps=(
                    "Your monthly trading limit resets automatically on the 1st of next month. "
                    "To increase your monthly volume limit, upgrade your KYC level."
                ),
            )
        ],
    },

    # ── Withdrawal blocks ─────────────────────────────────────────────────────
    {
        "user_id": "USR-000005",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000005-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.under_review,
                reason="Unusual withdrawal pattern detected. Account is under routine review.",
                applied_at="2026-03-29T08:00:00Z",
                expected_lift_at="2026-04-05T08:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000006",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000006-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked due to a mismatch in registered bank account details.",
                applied_at="2026-03-25T14:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Please verify your bank account details under Settings > Payment Methods "
                    "and resubmit for review. The block will be lifted within 1 business day."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000011",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000011-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal disabled because your KYC verification has expired.",
                applied_at="2026-03-01T00:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Renew your KYC by re-submitting a valid national ID and selfie in the "
                    "Verification section. Withdrawals will resume within 24 hours of approval."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000017",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000017-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked — KYC documents have expired.",
                applied_at="2026-03-01T00:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Re-submit your identity documents via the KYC portal. "
                    "Withdrawals will be re-enabled within 24 hours of successful re-verification."
                ),
            )
        ],
    },

    # ── Trading blocks ────────────────────────────────────────────────────────
    {
        "user_id": "USR-000007",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000007-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.active,
                reason="Trading suspended due to a leverage limit breach on your account.",
                applied_at="2026-03-30T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000012",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000012-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.under_review,
                reason="Trading temporarily paused while a compliance review is in progress.",
                applied_at="2026-03-28T09:00:00Z",
                expected_lift_at="2026-04-04T09:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000018",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000018-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.active,
                reason="Trading blocked due to an unresolved margin call on your account.",
                applied_at="2026-03-27T16:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Please deposit sufficient funds to cover the margin deficit or close "
                    "open positions to bring your account back to the required margin level. "
                    "Trading will resume automatically once the margin call is resolved."
                ),
            )
        ],
    },

    # ── Deposit blocks ────────────────────────────────────────────────────────
    {
        "user_id": "USR-000008",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000008-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.active,
                reason="Deposits blocked because the linked payment method has been flagged for review.",
                applied_at="2026-03-26T13:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Remove the flagged payment method and add a new verified bank account "
                    "or card under Settings > Payment Methods. Deposits will resume immediately."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000019",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000019-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.under_review,
                reason="Deposit channel temporarily suspended while an account review is ongoing.",
                applied_at="2026-03-31T08:00:00Z",
                expected_lift_at="2026-04-03T08:00:00Z",
                can_self_resolve=False,
            )
        ],
    },

    # ── Full freeze — AML / compliance (never share specifics) ────────────────
    {
        "user_id": "USR-000009",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000009-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.under_review,
                reason="Your account has been temporarily frozen pending a compliance review.",
                applied_at="2026-03-20T00:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000010",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000010-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.under_review,
                reason="Account frozen as part of a regulatory review process.",
                applied_at="2026-03-22T00:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000015",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000015-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.active,
                reason="Account suspended following detection of unusual withdrawal patterns flagged by the AML monitoring system. A compliance specialist is reviewing the account.",
                applied_at="2026-02-14T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000016",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000016-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.active,
                reason="Account suspended after KYC documents were rejected due to mismatched identity information. Account access is blocked until KYC is successfully resubmitted and approved.",
                applied_at="2026-01-05T15:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000020",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000020-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.under_review,
                reason="Account frozen pending review of account funding documentation.",
                applied_at="2026-03-15T10:30:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },

    # ── Login block ───────────────────────────────────────────────────────────
    {
        "user_id": "USR-000013",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000013-001",
                type=RestrictionType.login_block,
                subtype="2fa_lost",
                status=RestrictionStatus.active,
                reason="Login blocked — 2FA authenticator access lost or invalidated.",
                applied_at="2026-03-31T06:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Submit a 2FA reset request: take a selfie clearly holding your National ID, "
                    "include a handwritten note stating your full name, account email, and "
                    "the words '2FA Reset Request'. Send this to our support team. "
                    "Our operations team will process the reset and notify you once complete."
                ),
            )
        ],
    },

    # ── Simulation pool — withdrawal blocks ───────────────────────────────────
    {
        "user_id": "USR-000026",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000026-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked because KYC documents have expired.",
                applied_at="2026-01-15T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Re-submit a valid ID document in the KYC portal. "
                    "Withdrawals will be re-enabled within 24 hours of approval."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000030",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000030-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.under_review,
                reason="Withdrawal paused pending verification of updated proof of residence.",
                applied_at="2026-02-22T09:00:00Z",
                expected_lift_at="2026-03-01T09:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000034",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000034-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked due to a failed identity check on the last submission.",
                applied_at="2026-03-01T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Resubmit your national ID with a clear, unobstructed photo. "
                    "Ensure all four corners of the document are visible."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000042",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000042-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked pending re-verification after KYC selfie mismatch.",
                applied_at="2026-02-18T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Retake your selfie under good lighting, holding your ID clearly visible. "
                    "Submit via the KYC portal. Block lifts within 24 hours of approval."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000046",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000046-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.under_review,
                reason="Withdrawal temporarily blocked while additional identity information is requested.",
                applied_at="2026-03-29T08:00:00Z",
                expected_lift_at="2026-04-05T08:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000052",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000052-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked — awaiting additional address verification documents.",
                applied_at="2026-04-03T09:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Upload a utility bill or bank statement issued within the last 3 months "
                    "showing your full address. The block will be lifted within 1 business day."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000058",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000058-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.under_review,
                reason="Unusual large withdrawal request flagged for manual review.",
                applied_at="2026-04-02T14:00:00Z",
                expected_lift_at="2026-04-09T14:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000062",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000062-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked pending completion of ongoing KYC review.",
                applied_at="2026-04-02T09:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000068",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000068-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal disabled — KYC review requires additional documentation.",
                applied_at="2026-04-02T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Provide a clear scan of your passport's photo page. "
                    "Withdrawals will resume within 24 hours of successful review."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000095",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000095-001",
                type=RestrictionType.withdrawal_block,
                status=RestrictionStatus.active,
                reason="Withdrawal blocked — KYC documents have expired and must be renewed.",
                applied_at="2026-01-01T00:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Renew your KYC by re-submitting a valid national ID and selfie. "
                    "Withdrawals will resume within 24 hours of approval."
                ),
            )
        ],
    },

    # ── Simulation pool — trading blocks ─────────────────────────────────────
    {
        "user_id": "USR-000027",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000027-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.active,
                reason="Trading suspended due to KYC identity mismatch requiring manual review.",
                applied_at="2026-02-06T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000033",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000033-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.under_review,
                reason="Trading paused while a routine compliance review is in progress.",
                applied_at="2026-01-26T09:00:00Z",
                expected_lift_at="2026-02-02T09:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000039",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000039-001",
                type=RestrictionType.trading_block,
                subtype="edd_incomplete",
                status=RestrictionStatus.active,
                reason="Account functionality limited — Enhanced Due Diligence (EDD) documents were not submitted within the compliance deadline.",
                applied_at="2026-01-21T12:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Please complete your Enhanced Due Diligence (EDD) submission as soon as possible. "
                    "Once submitted, inform our support team and we will forward your case directly "
                    "to the KYC team for review. Your account will be restored once KYC approves your profile."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000063",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000063-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.under_review,
                reason="Trading temporarily paused while KYC pending review is completed.",
                applied_at="2026-03-30T11:00:00Z",
                expected_lift_at="2026-04-06T11:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000071",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000071-001",
                type=RestrictionType.trading_block,
                status=RestrictionStatus.active,
                reason="Trading suspended as the account is undergoing compliance re-verification.",
                applied_at="2026-04-01T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },

    # ── Simulation pool — full freeze ─────────────────────────────────────────
    {
        "user_id": "USR-000028",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000028-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.under_review,
                reason="Account frozen following detection of a possible identity fraud attempt.",
                applied_at="2026-01-31T09:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000035",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000035-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.active,
                reason="Account suspended — ID type not accepted requires re-verification with a supported document.",
                applied_at="2026-03-06T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000043",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000043-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.under_review,
                reason="Account frozen pending review of source of funds documentation.",
                applied_at="2026-01-16T11:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000088",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000088-001",
                type=RestrictionType.full_freeze,
                status=RestrictionStatus.active,
                reason="Account suspended as part of an AML compliance investigation.",
                applied_at="2026-02-02T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },

    # ── Simulation pool — deposit blocks ─────────────────────────────────────
    {
        "user_id": "USR-000031",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000031-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.active,
                reason="Deposits blocked due to a name mismatch between the registered profile and bank account.",
                applied_at="2026-03-11T08:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Update your registered name to match your bank account exactly, "
                    "or link a bank account that matches your registered name."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000037",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000037-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.under_review,
                reason="Deposit channel under review — payment method flagged for suspicious activity.",
                applied_at="2026-02-09T10:00:00Z",
                expected_lift_at="2026-02-16T10:00:00Z",
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000047",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000047-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.active,
                reason="Deposits disabled while additional identity verification is pending.",
                applied_at="2026-03-30T10:00:00Z",
                expected_lift_at=None,
                can_self_resolve=False,
            )
        ],
    },
    {
        "user_id": "USR-000061",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000061-001",
                type=RestrictionType.deposit_block,
                status=RestrictionStatus.under_review,
                reason="Deposit channel paused while KYC pending review is completed.",
                applied_at="2026-04-01T08:00:00Z",
                expected_lift_at="2026-04-08T08:00:00Z",
                can_self_resolve=False,
            )
        ],
    },

    # ── Simulation pool — login blocks ────────────────────────────────────────
    {
        "user_id": "USR-000076",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000076-001",
                type=RestrictionType.login_block,
                subtype="wrong_password",
                status=RestrictionStatus.active,
                reason="Account locked due to multiple incorrect password attempts within a short period.",
                applied_at="2026-04-06T07:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Submit an account unlock request: take a selfie clearly holding your National ID, "
                    "include a handwritten note stating your full name, account email, and "
                    "the words 'Account Unlock Request'. Send this to our support team. "
                    "Our operations team will verify your identity and unlock the account."
                ),
            )
        ],
    },
    {
        "user_id": "USR-000082",
        "restrictions": [
            AccountRestriction(
                restriction_id="RST-000082-001",
                type=RestrictionType.login_block,
                subtype="wrong_password",
                status=RestrictionStatus.active,
                reason="Account locked due to multiple incorrect password attempts within a short period.",
                applied_at="2026-04-05T22:00:00Z",
                expected_lift_at=None,
                can_self_resolve=True,
                resolution_steps=(
                    "Submit an account unlock request: take a selfie clearly holding your National ID, "
                    "include a handwritten note stating your full name, account email, and "
                    "the words 'Account Unlock Request'. Send this to our support team. "
                    "Our operations team will verify your identity and unlock the account."
                ),
            )
        ],
    },
]

# ── Index ─────────────────────────────────────────────────────────────────────

_BY_ID: dict[str, AccountRestrictionsResponse] = {}

for _entry in _SEED:
    _uid = _entry["user_id"]
    _restrictions: list[AccountRestriction] = _entry["restrictions"]
    _has = len(_restrictions) > 0
    _active = [r for r in _restrictions if r.status != RestrictionStatus.lifted]

    _trading_blocked = any(
        r.type in (RestrictionType.trading_block, RestrictionType.full_freeze)
        for r in _active
    )
    _trading_block_reason: str | None = None
    if _trading_blocked:
        _r = next(
            r for r in _active
            if r.type in (RestrictionType.trading_block, RestrictionType.full_freeze)
        )
        _trading_block_reason = _r.reason

    _deposit_blocked = any(
        r.type in (RestrictionType.deposit_block, RestrictionType.full_freeze)
        for r in _active
    )
    _withdrawal_blocked = any(
        r.type in (RestrictionType.withdrawal_block, RestrictionType.full_freeze)
        for r in _active
    )

    _BY_ID[_uid] = AccountRestrictionsResponse(
        user_id=_uid,
        has_restrictions=_has,
        restrictions=_restrictions,
        trading_available=not _trading_blocked,
        trading_block_reason=_trading_block_reason,
        deposit_available=not _deposit_blocked,
        withdrawal_available=not _withdrawal_blocked,
    )


def get_by_user_id(user_id: str) -> AccountRestrictionsResponse | None:
    return _BY_ID.get(user_id)
