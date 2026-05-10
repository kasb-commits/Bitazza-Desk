"""
Intent resolver — maps (picked_category, opening_message) → fine-grained backend category.

Decouples the widget's customer-facing labels from the backend's routing layer.
Runs on the first user turn only (before any tool calls or overlays are applied).

Problems this solves:
  1. deposit_issue and trade_issue have no widget card — customers land in "other"
     and currently rely on mid-conversation upgrade keyword detection.
     The resolver catches this on turn 1 so the correct overlay, tools, and
     workflow guard are active from the very start.
  2. Customers sometimes pick the wrong financial category (e.g. select
     "Withdrawal Issue" but describe a deposit that didn't arrive).
     The resolver cross-checks the message and corrects the routing silently.

Fixed categories (returned unchanged — no ambiguity, message content irrelevant):
  kyc_verification, account_restriction, password_2fa_reset, fraud_security

Disambiguated:
  withdrawal_issue ↔ deposit_issue  — cross-check message content
  other             → any fine-grained category, or stay as "other"
"""

# Signal table: (backend_category, keywords).
# Checked top-to-bottom; first match wins — order encodes priority.
# fraud_security first: safety-critical, must never be downgraded to a lower category.
_SIGNALS: list[tuple[str, list[str]]] = [
    ("fraud_security", [
        "fraud", "scam", "hacked", "hack", "unauthorized", "phishing",
        "suspicious transaction", "stole", "stolen", "compromised",
        "someone else", "not me", "didn't do", "didn't place",
        "โกง", "แฮก", "ไม่ได้ทำ", "ถูกขโมย", "ผิดปกติ",
    ]),
    ("account_restriction", [
        "restricted", "suspended", "blocked", "locked", "freeze", "frozen",
        "account suspended", "account blocked", "can't access", "cannot access",
        "ระงับ", "บล็อก", "ถูกล็อก", "ถูกระงับ", "เข้าไม่ได้",
    ]),
    ("kyc_verification", [
        "kyc", "verify", "verification", "identity", "id check",
        "document", "passport", "national id", "selfie",
        "not verified", "pending verification", "kyc rejected", "kyc failed",
        "ยืนยัน", "ตัวตน", "เอกสาร", "หนังสือเดินทาง", "บัตรประชาชน",
    ]),
    ("deposit_issue", [
        "deposit", "top up", "topped up", "transfer in", "incoming transfer",
        "didn't receive", "not received", "not credited", "deposit not",
        "ฝาก", "โอนเข้า", "เงินฝาก", "ฝากไม่เข้า", "ฝากค้าง", "ยังไม่ได้รับ",
    ]),
    ("withdrawal_issue", [
        "withdraw", "withdrawal", "transfer out", "send to bank",
        "pending withdrawal", "stuck withdrawal", "withdrawal failed",
        "ถอน", "โอนออก", "ถอนเงิน", "ถอนไม่ได้", "ถอนค้าง",
    ]),
    ("trade_issue", [
        "trade", "trading", "order", "spot order", "futures", "position",
        "buy order", "sell order", "limit order", "market order",
        "liquidat", "margin call", "pnl", "profit and loss",
        "order stuck", "order cancelled", "order not filled",
        "เทรด", "ซื้อขาย", "ออเดอร์", "คำสั่งซื้อ", "คำสั่งขาย",
        "ฟิวเจอร์ส", "โพสิชั่น",
    ]),
    ("password_2fa_reset", [
        "password", "2fa", "two factor", "authenticator", "google authenticator",
        "can't log in", "cannot log in", "login problem", "forgot password",
        "reset password", "lost access", "2fa code", "otp", "verification code",
        "รหัสผ่าน", "เข้าสู่ระบบ", "ล็อกอิน", "ยืนยันตัวตน", "รีเซ็ต",
    ]),
]

# Categories with no ambiguity — no signal scan needed, return immediately.
_FIXED_CATEGORIES = frozenset({
    "kyc_verification",
    "account_restriction",
    "password_2fa_reset",
    "fraud_security",
})

# Pre-built lookup for cross-category disambiguation (withdrawal ↔ deposit).
_DEPOSIT_KEYWORDS = [kw for cat, kws in _SIGNALS if cat == "deposit_issue" for kw in kws]
_WITHDRAWAL_KEYWORDS = [kw for cat, kws in _SIGNALS if cat == "withdrawal_issue" for kw in kws]


def classify_intent(category: str | None, message: str) -> str:
    """
    Refine a widget-picked category using the opening message's content.
    Returns the fine-grained backend category string.

    Always deterministic — no LLM call, no latency overhead.
    Safe to call with any category; unknown categories are returned unchanged.
    """
    if not category:
        category = "other"

    # Fixed categories: unambiguous, no scan needed.
    if category in _FIXED_CATEGORIES:
        return category

    msg = message.lower()

    # "other": scan signals in priority order — first match wins.
    if category == "other":
        for target_category, keywords in _SIGNALS:
            if any(kw in msg for kw in keywords):
                return target_category
        return "other"

    # withdrawal_issue: check if message is actually about a deposit.
    if category == "withdrawal_issue":
        if any(kw in msg for kw in _DEPOSIT_KEYWORDS):
            return "deposit_issue"
        return "withdrawal_issue"

    # deposit_issue: check if message is actually about a withdrawal.
    if category == "deposit_issue":
        if any(kw in msg for kw in _WITHDRAWAL_KEYWORDS):
            return "withdrawal_issue"
        return "deposit_issue"

    # Unknown / future category — return as-is.
    return category
