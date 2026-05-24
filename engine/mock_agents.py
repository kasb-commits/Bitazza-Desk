"""
Mock human support agents with names and personalities.
Used to simulate a real agent handoff when escalation triggers.
"""
import logging
import random
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
        "name": "Ploy",
        "gender": "f",
        "avatar": "P",
        "avatar_url": "https://i.pravatar.cc/150?img=47",
        "personality": "warm and reassuring",
        "intro_en": "Hi there! I'm Ploy from the Freedom support team 😊 I've read through your conversation and I'm here to help you sort this out. Don't worry — you're in good hands!",
        "intro_th": "สวัสดีค่ะ ดิฉันชื่อพลอย จากทีมสนับสนุน Freedom นะคะ อ่านการสนทนาของคุณลูกค้าแล้วค่ะ ไม่ต้องกังวลนะคะ เดี๋ยวเราจัดการให้เองเลยค่ะ",
    },
    {
        "name": "James",
        "gender": "m",
        "avatar": "J",
        "avatar_url": "https://i.pravatar.cc/150?img=11",
        "personality": "direct and efficient",
        "intro_en": "Hey, James here from the Bitazza support team. I've got the full context of your issue. Let me take a look and get this resolved for you quickly.",
        "intro_th": "สวัสดีครับ ผม James จากทีมสนับสนุน Bitazza ครับ ได้รับข้อมูลการสนทนาของคุณลูกค้าแล้วครับ รอสักครู่นะครับ จะรีบดูแลให้เลยครับ",
    },
    {
        "name": "Mint",
        "gender": "f",
        "avatar": "M",
        "avatar_url": "https://i.pravatar.cc/150?img=49",
        "personality": "patient and detail-oriented",
        "intro_en": "Hello! This is Mint from the support team 🌿 I can see you've been waiting — I'm so sorry about that. I'm going to carefully go through everything and make sure we get this fully resolved.",
        "intro_th": "สวัสดีค่ะ มินต์จากทีมสนับสนุนนะคะ 🌿 ขอโทษที่รอนานนะคะ มินต์จะดูรายละเอียดทุกอย่างให้ครบถ้วนเลยค่ะ",
    },
    {
        "name": "Arm",
        "gender": "m",
        "avatar": "A",
        "avatar_url": "https://i.pravatar.cc/150?img=15",
        "personality": "friendly and knowledgeable",
        "intro_en": "Hi! I'm Arm, senior support specialist at Freedom/Bitazza. I've been briefed on your situation. Let's get this taken care of — I handle cases like this all the time!",
        "intro_th": "สวัสดีครับ ผม Arm ผู้เชี่ยวชาญด้านสนับสนุนอาวุโสครับ ดูเคสของคุณลูกค้าแล้วครับ ไม่ต้องเป็นห่วงนะครับ เจอแบบนี้บ่อยมาก จัดการได้แน่นอนครับ",
    },
    {
        "name": "Nook",
        "gender": "f",
        "avatar": "N",
        "avatar_url": "https://i.pravatar.cc/150?img=45",
        "personality": "empathetic and calm",
        "intro_en": "Hello, I'm Nook from the customer care team 🙏 I completely understand how frustrating this can be. I'm fully focused on your case right now and we'll work through this together.",
        "intro_th": "สวัสดีค่ะ นุ๊กจากทีมดูแลลูกค้าค่ะ 🙏 เข้าใจดีเลยว่ามันน่าหงุดหน่ายแค่ไหน ตอนนี้โฟกัสที่เคสของคุณลูกค้าเต็มที่เลยนะคะ เดี๋ยวเราแก้ไขด้วยกันค่ะ",
    },
]


CATEGORY_AGENT_MAP: dict[str, str] = {
    "kyc_verification":    "Mint",
    "account_restriction": "Arm",
    "password_2fa_reset":  "James",
    "fraud_security":      "Nook",
    "withdrawal_issue":    "Arm",
    "other":               "Ploy",
}

# Specialist intro templates keyed by category and language.
# {name} is replaced with the agent's name at render time.
CATEGORY_INTROS: dict[str, dict[str, str]] = {
    "kyc_verification": {
        "en": "Hi! I'm {name}, your KYC specialist 👋 I've reviewed your conversation and I'm here to sort out your identity verification. Walk me through where things are and I'll take it from here.",
        "th": "สวัสดีค่ะ ดิฉันชื่อ {name} ผู้เชี่ยวชาญด้าน KYC นะคะ 👋 อ่านการสนทนาแล้วค่ะ ให้ช่วยเรื่องการยืนยันตัวตนได้เลยนะคะ",
    },
    "account_restriction": {
        "en": "Hey, I'm {name} — account specialist here. I've seen the full context. Let's get your account restriction sorted out right now.",
        "th": "สวัสดีครับ ผม {name} ผู้เชี่ยวชาญด้านบัญชีครับ ดูรายละเอียดทั้งหมดแล้วครับ เดี๋ยวจัดการเรื่องการระงับบัญชีให้เลยครับ",
    },
    "password_2fa_reset": {
        "en": "Hi, {name} here — security specialist 🔐 I've got your conversation history. I'll help you get your 2FA / password reset handled securely. Can you confirm the email on your account so I can verify your identity?",
        "th": "สวัสดีครับ ผม {name} ผู้เชี่ยวชาญด้านความปลอดภัยครับ 🔐 อ่านการสนทนาแล้วครับ จะช่วยรีเซ็ต 2FA / รหัสผ่านให้อย่างปลอดภัยครับ ขอยืนยันอีเมลที่ลงทะเบียนไว้ได้เลยนะครับ",
    },
    "fraud_security": {
        "en": "Hello, I'm {name} from the fraud & security team 🚨 This is a priority case. I've read everything — please tell me exactly what happened and I'll take immediate action.",
        "th": "สวัสดีค่ะ ดิฉันชื่อ {name} จากทีมความปลอดภัยและป้องกันการฉ้อโกงนะคะ 🚨 เคสนี้เร่งด่วนค่ะ อ่านทุกอย่างแล้ว ช่วยเล่าให้ฟังว่าเกิดอะไรขึ้นได้เลยนะคะ",
    },
    "withdrawal_issue": {
        "en": "Hi! I'm {name}, withdrawal specialist here. I've reviewed your case — let's trace this transaction and get it resolved for you.",
        "th": "สวัสดีครับ ผม {name} ผู้เชี่ยวชาญด้านการถอนเงินครับ ดูเคสแล้วครับ เดี๋ยวติดตามธุรกรรมและจัดการให้เลยนะครับ",
    },
    "other": {
        "en": "Hi there! I'm {name} from the support team 😊 I've read through your conversation and I'm here to help. What can I do for you?",
        "th": "สวัสดีค่ะ ดิฉันชื่อ {name} จากทีมสนับสนุนนะคะ อ่านการสนทนาแล้วค่ะ มีอะไรให้ช่วยได้บ้างคะ",
    },
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
    """Return the agent for the given category, or a random one if unknown."""
    if category and category in CATEGORY_AGENT_MAP:
        name = CATEGORY_AGENT_MAP[category]
        return _AGENTS_BY_NAME[name]
    return random.choice(AGENTS)


def get_intro_message(agent: dict, language: str, category: str | None = None) -> str:
    """
    Return a specialist intro that acknowledges the user's actual issue.
    Falls back to the agent's generic intro if no category-specific template exists.
    """
    lang = language if language in ("en", "th") else "en"
    if category and category in CATEGORY_INTROS:
        template = CATEGORY_INTROS[category][lang]
        return template.format(name=agent["name"])
    return agent["intro_th"] if lang == "th" else agent["intro_en"]
