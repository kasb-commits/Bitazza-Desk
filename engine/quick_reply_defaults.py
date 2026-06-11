"""
Curated quick-reply pill library.

Used when quick_replies_mode == "curated" (admin-selected in Bot Config).
Also serves as the LLM fallback when the AI-generated pills fail validation.
"""

CURATED_QUICK_REPLIES: dict[str, dict[str, list[str]]] = {
    "kyc_verification": {
        "en": [
            "What documents do I need?",
            "My document was rejected",
            "Stuck on 'Under review'",
            "How long does approval take?",
        ],
        "th": [
            "ต้องใช้เอกสารอะไรบ้าง",
            "เอกสารของฉันถูกปฏิเสธ",
            "ติดอยู่ที่ 'กำลังตรวจสอบ'",
            "อนุมัติใช้เวลานานแค่ไหน",
        ],
    },
    "account_restriction": {
        "en": [
            "Why is my account restricted?",
            "How do I unlock it?",
            "I already submitted documents",
            "What's the expected timeline?",
        ],
        "th": [
            "ทำไมบัญชีถูกระงับ",
            "ปลดล็อกได้อย่างไร",
            "ส่งเอกสารไปแล้ว",
            "คาดว่าจะใช้เวลานานแค่ไหน",
        ],
    },
    "withdrawal_issue": {
        "en": [
            "My withdrawal is still pending",
            "Funds didn't arrive in my bank",
            "I have the transaction ID",
            "How long do withdrawals take?",
        ],
        "th": [
            "การถอนยังค้างอยู่",
            "เงินยังไม่ถึงบัญชีธนาคาร",
            "มี transaction ID แล้ว",
            "การถอนใช้เวลานานแค่ไหน",
        ],
    },
    "deposit_issue": {
        "en": [
            "My deposit hasn't arrived",
            "I have the transaction hash",
            "How long do deposits take?",
            "Is there a minimum deposit?",
        ],
        "th": [
            "เงินฝากยังไม่เข้า",
            "มี transaction hash แล้ว",
            "การฝากใช้เวลานานแค่ไหน",
            "มีขั้นต่ำการฝากไหม",
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
            "ไม่มีอุปกรณ์ 2FA แล้ว",
            "ไม่ได้รับ OTP",
            "ยังเข้าบัญชีไม่ได้",
        ],
    },
    "fraud_security": {
        "en": [
            "I didn't make this transaction",
            "My account may be compromised",
            "I received a suspicious message",
            "How do I secure my account?",
        ],
        "th": [
            "ฉันไม่ได้ทำธุรกรรมนี้",
            "บัญชีอาจถูกเข้าถึงโดยไม่ได้รับอนุญาต",
            "ได้รับข้อความน่าสงสัย",
            "จะรักษาความปลอดภัยบัญชีได้อย่างไร",
        ],
    },
    "other": {
        "en": [
            "I have a follow-up question",
            "Can you explain that further?",
            "I'm still having the issue",
        ],
        "th": [
            "มีคำถามเพิ่มเติม",
            "ช่วยอธิบายเพิ่มเติมได้ไหม",
            "ยังมีปัญหาอยู่",
        ],
    },
}


def get_curated_pills(category: str | None, language: str) -> list[str]:
    """
    Return curated pills for the given category and language.
    Reads from the DB first; falls back to the hardcoded dict if the DB
    has no row for this category/language.
    """
    cat  = category if category else "other"
    lang = language if language in ("en", "th") else "en"
    try:
        from db.conversation_store import get_curated_pills_db
        db_data = get_curated_pills_db()
        if db_data:
            resolved_cat = cat if cat in db_data else "other"
            row = db_data.get(resolved_cat, {})
            if lang in row:
                return row[lang]
    except Exception:
        pass
    # Hardcoded fallback
    resolved_cat = cat if cat in CURATED_QUICK_REPLIES else "other"
    return CURATED_QUICK_REPLIES[resolved_cat][lang]
