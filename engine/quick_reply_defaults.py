"""
Curated quick-reply pill library.

Used when quick_replies_mode == "curated" (admin-selected in Bot Config).
Also serves as the LLM fallback when the AI-generated pills fail validation.

Smart selection: instead of returning all pills for a category, an LLM picks
the 2-3 most relevant pills from the pool based on the bot's latest reply.
"""
import json
import logging

logger = logging.getLogger(__name__)

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

# ── Selection schema for structured output ────────────────────────────────────
_SELECTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "selected": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "minItems": 2,
            "maxItems": 3,
            "description": "The 2-3 most relevant pills copied exactly from the pool",
        },
    },
    "required": ["selected"],
}


def _get_pool(category: str | None, language: str) -> list[str]:
    """Get the full curated pill pool for a category, DB-first with hardcoded fallback."""
    cat = category if category else "other"
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
    resolved_cat = cat if cat in CURATED_QUICK_REPLIES else "other"
    return CURATED_QUICK_REPLIES[resolved_cat][lang]


def get_curated_pills(category: str | None, language: str) -> list[str]:
    """
    Return curated pills for the given category and language.
    Reads from the DB first; falls back to the hardcoded dict if the DB
    has no row for this category/language.
    """
    return _get_pool(category, language)


def select_curated_pills(
    category: str | None,
    language: str,
    bot_reply: str,
    user_message: str = "",
) -> list[str]:
    """
    Use Gemini to pick the 2-3 most relevant pills from the curated pool
    based on the bot's latest reply and conversation context.

    Falls back to the full pool on any error (LLM failure, timeout, etc.)
    so the customer always sees pills.
    """
    pool = _get_pool(category, language)
    if len(pool) <= 3:
        # Pool is small enough — no selection needed
        return pool

    try:
        from google import genai
        from google.genai import types as genai_types
        from config.settings import GEMINI_API_KEY, MODEL
        import httpx

        client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options=genai_types.HttpOptions(
                httpxClient=httpx.Client(trust_env=True),
                httpxAsyncClient=httpx.AsyncClient(trust_env=True),
            ),
        )

        pool_list = "\n".join(f"- {pill}" for pill in pool)

        prompt = (
            f"Bot's latest reply:\n{bot_reply[:300]}\n\n"
            f"Customer's last message:\n{user_message[:200]}\n\n"
            f"Available pills:\n{pool_list}\n\n"
            f"Pick the 2-3 pills that are the most relevant follow-up "
            f"to the bot's reply. Copy them exactly."
        )

        config = genai_types.GenerateContentConfig(
            system_instruction=(
                "You select the most contextually relevant quick-reply pills "
                "for a customer support chat. Return the best 2-3 pills from "
                "the pool, copied exactly as written. Pick pills that directly "
                "respond to the bot's question or follow up on the specific "
                "topic discussed. Do not invent new pills."
            ),
            response_mime_type="application/json",
            response_schema=_SELECTION_SCHEMA,
            max_output_tokens=1024,
        )

        response = client.models.generate_content(
            model=MODEL,
            contents=[genai_types.Content(
                role="user",
                parts=[genai_types.Part(text=prompt)],
            )],
            config=config,
        )

        data = json.loads(response.text)
        raw_selected = data.get("selected", [])
        # Only keep pills that exist in the pool (exact match)
        pool_set = set(pool)
        selected = [s for s in raw_selected if s in pool_set]

        if len(selected) >= 2:
            logger.info("curated_pills_selected", extra={
                "category": category, "pool_size": len(pool),
                "selected_count": len(selected), "selected": selected,
            })
            return selected

        # Fuzzy fallback: if exact match fails, keep any returned strings
        # that are valid (model might slightly rephrase)
        if len(raw_selected) >= 2:
            logger.info("curated_pills_selected_fuzzy", extra={
                "category": category, "selected": raw_selected,
            })
            return raw_selected[:3]

        logger.warning("curated_pill_selection_too_few", extra={
            "raw": raw_selected, "exact_match_count": len(selected),
        })

    except Exception:
        logger.exception("curated_pill_selection_failed")

    # Fallback: return full pool (same as old behaviour)
    return pool
