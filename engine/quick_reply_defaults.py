"""
Curated quick-reply pill library.

Used when quick_replies_mode == "curated" (admin-selected in Bot Config).
Also serves as the LLM fallback when the AI-generated pills fail validation.
Pills are shown as style/tone examples in the system prompt.
"""

CURATED_QUICK_REPLIES: dict[str, dict[str, list[str]]] = {
    "kyc_verification": {
        "en": [
            "What documents do I need?",
            "How long does it take?",
            "My document was rejected",
            "Stuck on 'Under review'",
        ],
        "th": [
            "ต้องใช้เอกสารอะไรบ้าง",
            "ใช้เวลานานแค่ไหน",
            "เอกสารของฉันถูกปฏิเสธ",
            "ติดอยู่ที่ 'กำลังตรวจสอบ'",
        ],
    },
    "account_restriction": {
        "en": [
            "Why is my account restricted?",
            "How do I unlock it?",
            "I already submitted documents",
            "Talk to an agent",
        ],
        "th": [
            "ทำไมบัญชีถูกระงับ",
            "ปลดล็อกได้อย่างไร",
            "ส่งเอกสารไปแล้ว",
            "ขอคุยกับเจ้าหน้าที่",
        ],
    },
    "withdrawal_issue": {
        "en": [
            "My withdrawal is still pending",
            "Funds didn't arrive",
            "I have the transaction ID",
            "How long does it take?",
        ],
        "th": [
            "การถอนยังค้างอยู่",
            "เงินยังไม่ถึง",
            "มี transaction ID แล้ว",
            "ใช้เวลานานแค่ไหน",
        ],
    },
    "deposit_issue": {
        "en": [
            "My deposit hasn't arrived",
            "I have the transaction ID",
            "How long does it take?",
            "Check my deposit status",
        ],
        "th": [
            "เงินฝากยังไม่เข้า",
            "มี transaction ID แล้ว",
            "ใช้เวลานานแค่ไหน",
            "เช็คสถานะการฝาก",
        ],
    },
    "password_2fa_reset": {
        "en": [
            "I forgot my password",
            "I lost my 2FA device",
            "I can't receive the OTP",
            "I'm still locked out",
        ],
        "th": [
            "ลืมรหัสผ่าน",
            "หมดสิทธิ์เข้าใช้ 2FA",
            "ไม่ได้รับ OTP",
            "ยังเข้าบัญชีไม่ได้",
        ],
    },
    "fraud_security": {
        "en": [
            "I didn't make this transaction",
            "My account may be hacked",
            "I received a suspicious message",
            "Talk to an agent",
        ],
        "th": [
            "ฉันไม่ได้ทำธุรกรรมนี้",
            "บัญชีอาจถูกแฮก",
            "ได้รับข้อความน่าสงสัย",
            "ขอคุยกับเจ้าหน้าที่",
        ],
    },
    "other": {
        "en": [
            "Tell me more",
            "How does this work?",
            "Talk to an agent",
        ],
        "th": [
            "บอกเพิ่มเติม",
            "ทำงานอย่างไร",
            "ขอคุยกับเจ้าหน้าที่",
        ],
    },
}


def get_curated_pills(category: str | None, language: str) -> list[str]:
    """Return curated pills for the given category and language."""
    cat  = category if category in CURATED_QUICK_REPLIES else "other"
    lang = language if language in ("en", "th") else "en"
    return CURATED_QUICK_REPLIES[cat][lang]
