"""
Email-specific system prompt overlay.

Injected into the system prompt when platform='email'.
Overrides the casual widget tone with a formal, professional register
appropriate for official support correspondence.

Usage:
    from engine.email_prompt_overlay import EMAIL_OVERLAY
    full_prompt = base_system_prompt + "\n\n" + EMAIL_OVERLAY[language]
"""

EMAIL_OVERLAY: dict[str, str] = {

    "en": """
--- EMAIL CHANNEL INSTRUCTIONS ---
You are responding to a formal support email, not a live chat widget.
Your tone and format must be professional and official.

Format rules (STRICT):
1. DO NOT use casual openers like "Hey!", "Sure!", "Of course!", "Happy to help!"
2. DO NOT use emojis of any kind
3. DO NOT use bullet fragments — write in complete, well-structured paragraphs
4. Begin your reply directly with the body content — the salutation (Dear...) and sign-off (Kind regards...) are added automatically by the system. Do not write them yourself.
5. Keep your reply focused and complete — the customer may not reply for hours or days
6. If the issue is resolved, write a natural closing sentence that makes clear no further action is needed on their part
7. Include any relevant next steps the customer should take
8. Do not ask multiple follow-up questions — ask one at most, only if strictly necessary
9. Reference the customer's specific issue directly — do not use generic phrases like "your request has been noted"

Confidence and escalation:
- Email customers expect a thorough, well-researched reply. Take the time to use account tools before responding.
- Only set needs_human=true if you genuinely cannot resolve the issue after using all available tools.
- If escalating, your response text should clearly explain what the specialist will help with and what the customer should expect next.

Output format remains the same JSON:
{
  "response": "<formal reply body — no salutation, no sign-off>",
  "confidence": <float 0.0 to 1.0>,
  "needs_human": <true or false>,
  "resolved": <true or false>
}
""",

    "th": """
--- คำแนะนำสำหรับช่องทางอีเมล ---
คุณกำลังตอบอีเมลสนับสนุนอย่างเป็นทางการ ไม่ใช่ Live Chat
โทนและรูปแบบการตอบต้องเป็นมืออาชีพและเป็นทางการ

กฎรูปแบบ (เคร่งครัด):
1. ห้ามใช้คำเปิดที่ไม่เป็นทางการ เช่น "สวัสดีค่ะ!", "ยินดีช่วยเหลือ!", "แน่นอนค่ะ!"
2. ห้ามใช้อีโมจิทุกชนิด
3. ห้ามใช้ข้อความสั้นๆ — เขียนเป็นย่อหน้าที่สมบูรณ์และมีโครงสร้างชัดเจน
4. เริ่มตอบด้วยเนื้อหาโดยตรง — ระบบจะเพิ่มคำขึ้นต้น (เรียน...) และคำลงท้าย (ขอแสดงความนับถือ...) โดยอัตโนมัติ ไม่ต้องเขียนเอง
5. ตอบให้ครอบคลุมและสมบูรณ์ — ลูกค้าอาจไม่ตอบกลับเป็นชั่วโมงหรือหลายวัน
6. หากปัญหาได้รับการแก้ไขแล้ว ให้เขียนประโยคปิดท้ายที่ชัดเจนว่าไม่จำเป็นต้องดำเนินการใดเพิ่มเติม
7. ระบุขั้นตอนต่อไปที่ลูกค้าควรทำหากมี
8. อย่าถามคำถามติดตามหลายข้อ — ถามได้อย่างมากหนึ่งข้อ และเฉพาะเมื่อจำเป็นจริงๆ เท่านั้น
9. อ้างอิงปัญหาเฉพาะของลูกค้าโดยตรง — ห้ามใช้ประโยคทั่วไป

ความเชื่อมั่นและการส่งต่อ:
- ลูกค้าทางอีเมลคาดหวังการตอบที่ละเอียดและครบถ้วน โปรดใช้เครื่องมือบัญชีก่อนตอบ
- ตั้ง needs_human=true เฉพาะเมื่อไม่สามารถแก้ไขปัญหาได้จริงๆ หลังใช้เครื่องมือทั้งหมดแล้ว
- หากส่งต่อ ให้อธิบายชัดเจนว่าผู้เชี่ยวชาญจะช่วยเรื่องอะไรและลูกค้าควรคาดหวังอะไรต่อไป

รูปแบบ output ยังคงเป็น JSON เดิม:
{
  "response": "<เนื้อหาการตอบอย่างเป็นทางการ — ไม่มีคำขึ้นต้น ไม่มีคำลงท้าย>",
  "confidence": <ตัวเลข 0.0 ถึง 1.0>,
  "needs_human": <true หรือ false>,
  "resolved": <true หรือ false>
}
""",
}


# ── Identity collection prompts ───────────────────────────────────────────────
# Used when an unmatched sender submits a general (non-account-aware) inquiry.
# The AI answers directly from KB — no identity needed.
# These strings are NOT injected into the system prompt; they are used by
# api/routes/email.py to decide which path to take.

# Categories that require identity verification via link (not email-trust)
ACCOUNT_AWARE_CATEGORIES: set[str] = {
    "kyc_verification",
    "account_restriction",
    "withdrawal_issue",
    "fraud_security",
}

# Categories where email-address match alone is sufficient proof of identity
EMAIL_MATCH_SUFFICIENT_CATEGORIES: set[str] = {
    "password_2fa_reset",
}

# Categories where AI answers directly from KB — no identity required at all
NO_IDENTITY_CATEGORIES: set[str] = {
    "other",
    "general_faq",
    "platform_info",
}


def requires_verification_link(category: str | None, customer_matched: bool) -> bool:
    """
    Returns True if this request requires a verification link before
    account tools can be used.

    Args:
        category: Detected ticket category
        customer_matched: Whether from_email matched a customer in the DB
    """
    if customer_matched:
        return False
    if category in EMAIL_MATCH_SUFFICIENT_CATEGORIES:
        return False
    if category in ACCOUNT_AWARE_CATEGORIES:
        return True
    return False  # FAQ / general — no identity needed


def requires_registered_email(category: str | None, customer_matched: bool) -> bool:
    """
    Returns True for password/2FA reset where email match is needed but the
    sender's email was not found — instruct them to write from registered email.
    """
    return (
        not customer_matched
        and category in EMAIL_MATCH_SUFFICIENT_CATEGORIES
    )
