"""
Mock human support agents with names and personalities.
Used to simulate a real agent handoff when escalation triggers.
"""
import logging
import time
from config.settings import MODEL


def _call_with_retry(fn, max_attempts: int = 3, base_delay: float = 0.5):
    """Retry helper — mirrors engine.agent._call_with_retry (kept separate to avoid circular import)."""
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            if attempt < max_attempts:
                logging.warning(
                    "Gemini classify failed (attempt %d/%d): %s — retrying in %.1fs",
                    attempt, max_attempts, e, base_delay * attempt,
                )
                time.sleep(base_delay * attempt)
            else:
                logging.error(
                    "Gemini classify failed after %d attempts: %s",
                    max_attempts, e,
                )
    raise last_exc  # type: ignore[misc]

AGENTS = [
    {
        "name": "Aria",
        "gender": "f",
        "avatar": "A",
        "avatar_url": "/brand/logo.png",
        "personality": "friendly and professional",
        "intro_en": "Hi! I'm Aria, your AI support assistant. 🤖 I'll gladly help you on this session.",
        "intro_th": "สวัสดีค่ะ ดิฉันชื่อ Aria เป็น AI ผู้ช่วยฝ่ายสนับสนุนค่ะ 🤖 ยินดีช่วยเหลือคุณลูกค้าในเซสชันนี้เลยนะคะ",
    },
]


CATEGORY_AGENT_MAP: dict[str, str] = {
    "kyc_verification":    "Aria",
    "account_restriction": "Aria",
    "password_2fa_reset":  "Aria",
    "fraud_security":      "Aria",
    "withdrawal_issue":    "Aria",
    "other":               "Aria",
}


# Keyword signals used to infer category from message text mid-conversation.
_CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "password_2fa_reset": ["2fa", "two factor", "authenticator", "password", "reset", "login", "otp", "รหัสผ่าน", "ล็อกอิน"],
    "kyc_verification":   ["kyc", "verify", "verification", "identity", "id", "document", "passport", "selfie", "ยืนยัน", "ตัวตน"],
    "account_restriction": ["restricted", "suspended", "blocked", "locked", "freeze", "restriction",
                            "cant deposit", "can't deposit", "cannot deposit", "deposit blocked",
                            "cant withdraw", "can't withdraw", "cannot withdraw",
                            "cant trade", "can't trade", "cannot trade",
                            "ระงับ", "บล็อก", "ฝากเงิน", "ไม่สามารถฝาก"],
    "fraud_security":     ["fraud", "scam", "hacked", "unauthorized", "stolen", "suspicious", "ฉ้อโกง", "แฮก"],
    "withdrawal_issue":   ["withdraw", "withdrawal", "transfer", "stuck", "pending", "ถอน", "โอนเงิน"],
}


def detect_category_from_message(message: str) -> str | None:
    """
    Infer the most likely issue category from message keywords.
    Returns a category key or None if no strong signal found.
    """
    msg = message.lower()
    for category, keywords in _CATEGORY_KEYWORDS.items():
        if any(kw in msg for kw in keywords):
            return category
    return None


_GEMINI_CLASSIFY_PROMPT = """You are a customer support ticket classifier for a crypto exchange.
Classify the customer message into exactly one of these categories:
- kyc_verification: identity verification, document upload, KYC status
- account_restriction: account blocked, suspended, frozen, can't deposit, can't trade, access restricted
- withdrawal_issue: withdrawal stuck, failed, pending, not received
- password_2fa_reset: can't log in, forgot password, 2FA issues
- fraud_security: scam, hacked, unauthorized access, stolen funds
- other: anything else

Reply with ONLY the category key, nothing else.

Customer message: {message}"""


def classify_message_with_gemini(message: str) -> str | None:
    """
    Use Gemini Flash to classify a message into a support category.
    Retries up to 3 times on any exception before giving up.
    Returns a category key or None on failure (caller falls back to keyword match).
    """
    try:
        import google.genai as genai
        from config.settings import GEMINI_API_KEY
        client = genai.Client(api_key=GEMINI_API_KEY)
        result = _call_with_retry(
            lambda: client.models.generate_content(
                model=MODEL,
                contents=_GEMINI_CLASSIFY_PROMPT.format(message=message),
                config={"temperature": 0, "max_output_tokens": 20},
            )
        )
        raw = result.text.strip().lower().replace(" ", "_")
        valid = {"kyc_verification", "account_restriction", "withdrawal_issue",
                 "password_2fa_reset", "fraud_security", "other"}
        return raw if raw in valid else None
    except Exception:
        return None


_AGENTS_BY_NAME: dict[str, dict] = {a["name"]: a for a in AGENTS}


def pick_agent(category: str | None = None) -> dict:
    """Return the single AI bot agent."""
    return AGENTS[0]


def get_intro_message(agent: dict, language: str, category: str | None = None) -> str:
    """Return the bot's intro message in the appropriate language."""
    lang = language if language in ("en", "th") else "en"
    return agent["intro_th"] if lang == "th" else agent["intro_en"]
