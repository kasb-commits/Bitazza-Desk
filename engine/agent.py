"""
Main AI Support Engine.
Orchestrates: language detection → security filter → RAG retrieval →
account tools → Gemini Flash (JSON response with confidence) → compliance filter → escalation.

Gemini is instructed to return structured JSON: {response, confidence, needs_human}.
This means escalation is driven by Gemini's own assessment, not post-hoc heuristics.
"""
import json, logging, re, time
from google import genai
from google.genai import types as genai_types
from google.genai import errors as genai_errors
from config.settings import GEMINI_API_KEY, MODEL, MAX_TOKENS, ESCALATION_CONFIDENCE_THRESHOLD
from engine.retriever import retrieve_with_fallback
from engine.account_tools import TOOLS, TOOL_DEFINITIONS, get_user_profile
from engine.security_filter import pre_filter, post_filter, contains_financial_advice_request
from engine.escalation import should_escalate
from engine.prompt_templates import (
    get_system_prompt, get_guest_system_prompt, build_user_message,
    build_handoff_message, ESCALATION_MESSAGES, UNABLE_TO_HELP_MESSAGES,
    build_collection_prompt,
)
from engine.mock_agents import pick_agent, detect_category_from_message, get_intro_message
from db.conversation_store import (
    get_history, add_message, create_ticket,
    get_ai_persona, update_ticket_status,
    get_ticket_id_by_conversation, update_customer_from_profile,
    get_ticket_meta, get_info_collection_phase, set_info_collection_phase,
    count_collection_turns,
)
from db.vector_store import collection_count
from engine.assignment_client import trigger_auto_assign

client = genai.Client(api_key=GEMINI_API_KEY)


def _call_with_retry(fn, max_attempts: int = 3, base_delay: float = 0.5):
    """
    Call fn up to max_attempts times with exponential backoff.
    Logs a WARNING per failed non-final attempt and ERROR on final failure.
    Raises the last exception if all attempts are exhausted.
    """
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            if attempt < max_attempts:
                logging.warning(
                    "Gemini call failed (attempt %d/%d): %s — retrying in %.1fs",
                    attempt, max_attempts, e, base_delay * attempt,
                )
                time.sleep(base_delay * attempt)
            else:
                logging.error(
                    "Gemini call failed after %d attempts: %s",
                    max_attempts, e,
                )
    raise last_exc  # type: ignore[misc]



# Fields that must never be fabricated when null — replace with explicit marker
# before passing tool results to Gemini so the model cannot guess a reason.
_NULL_REASON_FIELDS = {
    "rejection_reason", "restriction_reason", "failure_reason",
    "trading_block_reason", "resolution_steps",
}


def _sanitize_tool_result(result: dict) -> dict:
    """Replace null values in sensitive reason-fields with an explicit do-not-guess marker."""
    sanitized = {}
    for key, value in result.items():
        if isinstance(value, dict):
            sanitized[key] = _sanitize_tool_result(value)
        elif isinstance(value, list):
            sanitized[key] = [
                _sanitize_tool_result(item) if isinstance(item, dict) else item
                for item in value
            ]
        elif key in _NULL_REASON_FIELDS and value is None:
            sanitized[key] = "[NOT PROVIDED — do not guess or infer this value]"
        else:
            sanitized[key] = value
    return sanitized


_LANG_KEYWORDS_TH = ["ขอ", "คุณ", "ไม่", "ได้", "ว่า", "ใน", "และ", "มี", "การ", "ที่"]


def detect_language(text: str) -> str:
    """Simple Thai detection by Unicode range. Defaults to English."""
    thai_chars = sum(1 for c in text if "\u0e00" <= c <= "\u0e7f")
    return "th" if thai_chars / max(len(text), 1) > 0.1 else "en"


def _clean_response(text: str) -> str:
    """Strip markdown formatting artifacts from Gemini output.

    The widget renders plain text (whitespace-pre-wrap, no markdown parser),
    so bold markers, bullet asterisks, and excess blank lines appear as raw
    characters if left in. This normalises the text before it reaches the user.
    """
    # Remove bold/italic markers (**text**, *text*, __text__, _text_)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    # Remove leading bullet/list markers (lines starting with * or - followed by space)
    text = re.sub(r"(?m)^[\*\-]\s+", "", text)
    # Collapse 3+ consecutive blank lines down to 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_ACCOUNT_SPECIFIC_CATEGORIES = {
    "kyc_verification", "account_restriction", "withdrawal_issue",
    "deposit_issue", "fraud_security", "trade_issue",
}


def _is_account_specific_category(category: str | None) -> bool:
    return bool(category and category in _ACCOUNT_SPECIFIC_CATEGORIES)


class AgentResponse:
    def __init__(self, text: str, language: str, escalated: bool = False,
                 escalation_reason: str = "", ticket_id: str | None = None,
                 agent_name: str | None = None, agent_avatar: str | None = None,
                 agent_avatar_url: str | None = None, resolved: bool = False,
                 specialist_intro: str | None = None, confidence: float = 1.0,
                 upgraded_category: str | None = None,
                 transition_message: str | None = None,
                 info_collection: bool = False,
                 profile_fetched: bool = False):
        self.text = text
        self.language = language
        self.escalated = escalated
        self.escalation_reason = escalation_reason
        self.ticket_id = ticket_id
        self.agent_name = agent_name
        self.agent_avatar = agent_avatar
        self.agent_avatar_url = agent_avatar_url
        self.resolved = resolved
        self.specialist_intro = specialist_intro
        self.confidence = confidence
        self.upgraded_category = upgraded_category  # set when mid-convo category switch occurs
        self.transition_message: str | None = transition_message  # outgoing-agent farewell shown before specialist reply
        self.info_collection = info_collection  # True when this reply is a collection-phase question
        self.profile_fetched = profile_fetched  # True when get_user_profile tool was called this turn


_UPGRADE_TRANSITION_MESSAGES: dict[str, dict[str, str]] = {
    "kyc_verification": {
        "en": "For KYC and identity verification questions I'll hand you over to {specialist} — our verification specialist. They'll have our full conversation and can pull up your case directly. One moment! 🪪",
        "th": "สำหรับเรื่อง KYC และการยืนยันตัวตน ขอส่งต่อให้ {specialist} ผู้เชี่ยวชาญด้านการยืนยันตัวตนของเรานะคะ เจ้าหน้าที่จะเห็นการสนทนาทั้งหมดและดึงข้อมูลเคสของคุณลูกค้าได้โดยตรงเลยค่ะ รอสักครู่นะคะ 🪪",
    },
    "withdrawal_issue": {
        "en": "Withdrawal questions are best handled by {specialist} — our withdrawal specialist who can trace transactions directly. Passing you over now, they'll have everything we've discussed! 💸",
        "th": "เรื่องการถอนเงินให้ {specialist} ผู้เชี่ยวชาญด้านการถอนเงินของเราจัดการดีกว่าค่ะ เจ้าหน้าที่สามารถติดตามธุรกรรมได้โดยตรงเลย กำลังส่งต่อให้เดี๋ยวนี้เลยค่ะ 💸",
    },
    "account_restriction": {
        "en": "Account restriction cases need a senior specialist — let me bring in {specialist} who can investigate and take action on your account directly. They'll be right with you! 🔒",
        "th": "เคสบัญชีถูกระงับต้องใช้ผู้เชี่ยวชาญอาวุโสค่ะ ขอให้ {specialist} มาช่วยซึ่งสามารถตรวจสอบและดำเนินการกับบัญชีของคุณได้โดยตรงเลยนะคะ 🔒",
    },
    "deposit_issue": {
        "en": "Deposit problems are handled by {specialist} — our deposits specialist who can trace your transaction directly. Passing you over now, they'll have everything we've discussed! 💳",
        "th": "เรื่องการฝากเงินให้ {specialist} ผู้เชี่ยวชาญด้านการฝากเงินของเราจัดการดีกว่าค่ะ เจ้าหน้าที่สามารถติดตามธุรกรรมได้โดยตรงเลย กำลังส่งต่อให้เดี๋ยวนี้เลยค่ะ 💳",
    },
    "trade_issue": {
        "en": "For trading and order issues, let me bring in {specialist} — our trading specialist who can pull up your order history and investigate directly. One moment! 📊",
        "th": "สำหรับปัญหาการเทรดและออเดอร์ ขอให้ {specialist} ผู้เชี่ยวชาญด้านการเทรดของเรามาช่วยค่ะ เจ้าหน้าที่สามารถดึงประวัติออเดอร์และตรวจสอบได้โดยตรงเลย รอสักครู่นะคะ 📊",
    },
}


# Keywords that signal the user is asking about a specific account domain
# mid-conversation (e.g. while chatting in "other" category).
_UPGRADE_KEYWORDS: dict[str, list[str]] = {
    "kyc_verification":    ["kyc", "verify", "verification", "identity", "id check", "document", "passport",
                            "selfie", "ยืนยัน", "ตัวตน", "kyc status", "my kyc",
                            # kyc submission signals — catches from account_restriction
                            "kyc failed", "kyc rejected", "kyc error", "document upload", "upload failed",
                            "submission failed", "kyc submission", "resubmit", "id upload",
                            "ส่ง kyc", "kyc ไม่ผ่าน", "อัปโหลดเอกสาร", "ส่งเอกสาร", "kyc ถูกปฏิเสธ"],
    "password_2fa_reset":  ["can't log in", "cant log in", "cannot log in", "login failed", "can't login",
                            "locked out", "account locked", "can't access", "cannot access",
                            "forgot password", "reset password", "lost access", "sign in",
                            "2fa", "authenticator", "otp not working",
                            "log in ไม่ได้", "เข้าไม่ได้", "ล็อกอินไม่ได้", "ลืมรหัสผ่าน",
                            "รหัสผ่านผิด", "เข้าสู่ระบบไม่ได้", "บัญชีถูกล็อก"],
    "account_restriction": ["restricted", "suspended", "blocked", "locked", "freeze", "restriction",
                            "ระงับ", "บล็อก", "account status", "why is my account"],
    "withdrawal_issue":    ["withdraw", "withdrawal", "transfer out", "stuck withdrawal", "pending withdrawal",
                            "ถอน", "โอนเงิน", "my withdrawal"],
    "deposit_issue":       ["deposit", "top up", "topped up", "deposit failed", "deposit stuck",
                            "deposit not arrived", "didn't receive", "transfer in", "incoming transfer",
                            "ฝาก", "โอนเข้า", "เงินฝาก", "ฝากไม่เข้า", "ฝากค้าง"],
    "trade_issue":         ["trade", "trading", "order", "spot order", "futures", "position",
                            "buy order", "sell order", "limit order", "market order", "liquidat",
                            "margin call", "pnl", "profit and loss",
                            "เทรด", "ซื้อขาย", "ออเดอร์", "คำสั่งซื้อ", "คำสั่งขาย", "ฟิวเจอร์ส"],
}

_UPGRADEABLE_FROM = {"other", "deposit_issue", "trade_issue", "account_restriction"}  # account_restriction upgrades to kyc/password when signals are clear

# Matches platform transaction IDs (TXN-001, TXN-9999) and blockchain tx hashes (0x…).
# Used to detect when a user provides a specific transaction reference mid-conversation
# so the agent can be forced to look it up regardless of conversation turn.
_TX_ID_RE = re.compile(r'\bTXN-\w[\w-]*|0x[0-9a-fA-F]{10,}', re.IGNORECASE)

# Matches spot order IDs (SPT-xxx) and futures position IDs (FUT-xxx).
# Used to force the relevant trading tool when a user quotes a specific order/position reference.
_SPOT_ORDER_RE = re.compile(r'\bSPT-\w[\w-]*', re.IGNORECASE)
_FUTURES_POS_RE = re.compile(r'\bFUT-\w[\w-]*', re.IGNORECASE)


def _detect_upgrade(message: str, current_category: str | None) -> str | None:
    """
    If the user is in an upgradeable category and their message clearly signals a different
    account domain, return the target category key. Otherwise return None.
    Never returns the same category the user is already in.
    """
    if current_category not in _UPGRADEABLE_FROM:
        return None
    msg = message.lower()
    for category, keywords in _UPGRADE_KEYWORDS.items():
        if category == current_category:
            continue  # never upgrade to the current category
        if any(kw in msg for kw in keywords):
            return category
    return None


# Keyword sets for detecting what kind of problem a customer is describing
# within account_restriction, used to select the right collection questions.
_SYMPTOM_KEYWORDS: dict[str, list[str]] = {
    "transaction_failed": [
        "failed", "rejected", "declined", "didn't go through", "did not go through",
        "not received", "not arrived", "never arrived", "didn't arrive", "transaction failed",
        "transfer failed", "payment failed",
        "ล้มเหลว", "ไม่สำเร็จ", "ไม่ผ่าน", "ถูกปฏิเสธ", "ไม่เข้า", "ไม่ได้รับ",
    ],
    "transaction_pending": [
        "pending", "stuck", "processing", "hasn't arrived", "not showing",
        "still processing", "waiting", "delayed", "not confirmed", "unconfirmed",
        "รอดำเนินการ", "ค้าง", "ยังไม่เข้า", "ยังไม่ได้รับ", "รออยู่", "ยังรอ",
    ],
    "feature_blocked": [
        "can't", "cannot", "can not", "won't let me", "not letting me",
        "unable to", "disabled", "greyed out", "grayed out", "not available",
        "not working", "doesn't work", "isn't working", "button", "option missing",
        "ทำไม่ได้", "ใช้ไม่ได้", "กดไม่ได้", "ปุ่มเป็นสีเทา", "ไม่สามารถ", "ฟีเจอร์ใช้งานไม่ได้",
    ],
    "ui_error": [
        "error", "error message", "crash", "won't load", "not loading", "blank screen",
        "spinning", "keeps loading", "error code", "something went wrong", "page not found",
        "500", "404", "broken", "white screen",
        "โหลดไม่ได้", "แสดงข้อผิดพลาด", "error ขึ้น", "หน้าเปล่า", "ค้างโหลด",
        "หน้าไม่โหลด", "แอปค้าง", "แอปพัง",
    ],
}


def detect_symptom_type(message: str) -> str:
    """
    Classify what kind of problem the customer is describing within account_restriction.
    Returns one of: transaction_failed, transaction_pending, feature_blocked, ui_error, unclear.
    Checked in priority order — transaction_failed before transaction_pending to avoid
    ambiguity when both signals appear.
    """
    msg = message.lower()
    for symptom in ("transaction_failed", "transaction_pending", "ui_error", "feature_blocked"):
        if any(kw in msg for kw in _SYMPTOM_KEYWORDS[symptom]):
            return symptom
    return "unclear"


def chat(
    conversation_id: str,
    user_id: str | None,
    user_message: str,
    platform: str = "web",
    consecutive_low_confidence: int = 0,
    category: str | None = None,
    suppress_handoff: bool = False,
    _skip_upgrade: bool = False,
    override_language: str | None = None,
    injected_account_data: dict | None = None,
) -> AgentResponse:
    """
    Process a user message and return an AgentResponse.
    Caller is responsible for persisting messages via conversation_store.
    override_language: when set, use this instead of per-message detection.
    Pass the language the user selected at session start so the bot doesn't
    switch to English just because the message contains English crypto terms.
    """
    language = override_language if override_language else detect_language(user_message)

    # 1. Security pre-filter
    check = pre_filter(user_message)
    if not check.allowed:
        return AgentResponse(
            text=("I'm unable to process that request. If you need help, please describe your issue normally."
                  if language == "en"
                  else "ไม่สามารถประมวลผลคำขอนั้นได้ หากคุณต้องการความช่วยเหลือ กรุณาอธิบายปัญหาของคุณตามปกติ"),
            language=language,
        )

    # 2. Financial advice guard
    if contains_financial_advice_request(user_message):
        msg = ("I'm not able to provide investment or financial advice. For trading decisions, please consult a qualified financial advisor."
               if language == "en"
               else "ไม่สามารถให้คำแนะนำการลงทุนหรือทางการเงินได้ สำหรับการตัดสินใจซื้อขาย กรุณาปรึกษาที่ปรึกษาทางการเงินที่มีคุณสมบัติ")
        return AgentResponse(text=msg, language=language)

    # 2b. No active workflow for account-specific category → escalate to human specialist.
    # These categories require live account data; without a workflow providing structured
    # guardrails, the safe action is to hand off rather than let free-form AI handle it.
    # suppress_handoff=True means we're called from inside a workflow node — skip this guard.
    # Guests (user_id=None) skip this block — they get KB-based guidance instead.
    from db.conversation_store import is_human_handling as _is_human_check
    _ACCOUNT_CATEGORIES = {"kyc_verification", "account_restriction", "withdrawal_issue", "deposit_issue", "trade_issue", "fraud_security"}
    if category in _ACCOUNT_CATEGORIES and not suppress_handoff and user_id is not None and not _is_human_check(conversation_id):
        # Check if a published workflow exists for this category — if so, let it run instead.
        try:
            from workflow_engine.store import get_published_workflows_by_trigger
            _has_workflow = bool(get_published_workflows_by_trigger("web", category))
        except Exception:
            _has_workflow = False
        if not _has_workflow:
            ticket_id = get_ticket_id_by_conversation(conversation_id)
            if ticket_id:
                _escalation_status = "Escalated" if platform == "email" else "pending_human"
                update_ticket_status(ticket_id, _escalation_status)
                _meta = get_ticket_meta(ticket_id)
                if _meta.get("customer_id"):
                    trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))
            return AgentResponse(
                text=build_handoff_message(category, language),
                language=language,
                escalated=True,
                escalation_reason="no_active_workflow",
                ticket_id=ticket_id if ticket_id else None,
            )

    # 3a. Mid-conversation category upgrade detection
    # If the user is in an upgradeable category and asks about a different account domain,
    # transparently re-route to the dedicated specialist agent for that category.
    # _skip_upgrade prevents infinite recursion when this function calls itself recursively.
    upgrade = None if _skip_upgrade else _detect_upgrade(user_message, category)
    if upgrade:
        from engine.mock_agents import pick_agent as _pick_agent
        specialist = _pick_agent(upgrade)
        # Re-run with the upgraded category so tools & overlay are applied correctly
        upgraded_result = chat(
            conversation_id=conversation_id,
            user_id=user_id,
            user_message=user_message,
            platform=platform,
            consecutive_low_confidence=consecutive_low_confidence,
            category=upgrade,
            _skip_upgrade=True,
            override_language=override_language,
        )
        upgraded_result.upgraded_category = upgrade
        upgraded_result.agent_name = specialist["name"]
        upgraded_result.agent_avatar = specialist["avatar"]
        upgraded_result.agent_avatar_url = specialist["avatar_url"]
        # Build the handoff notice from the current (outgoing) agent — category-specific
        _transition_templates = _UPGRADE_TRANSITION_MESSAGES.get(upgrade, {})
        _transition_template = _transition_templates.get(language) or _transition_templates.get("en", "Let me connect you with {specialist} who can help with this directly!")
        upgraded_result.transition_message = _transition_template.format(specialist=specialist["name"])
        return upgraded_result

    # 3b. Check explicit escalation request before calling API
    escalate, reason = should_escalate(user_message, 1.0, consecutive_low_confidence)
    if escalate and reason == "user_requested_human":
        ticket_id = get_ticket_id_by_conversation(conversation_id)
        if ticket_id:
            _escalation_status = "Escalated" if platform == "email" else "pending_human"
            update_ticket_status(ticket_id, _escalation_status)
            _meta = get_ticket_meta(ticket_id)
            if _meta.get("customer_id"):
                trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))
        effective_category = detect_category_from_message(user_message) or category
        reply_text = "" if suppress_handoff else build_handoff_message(effective_category, language)
        return AgentResponse(
            text=reply_text,
            language=language, escalated=True,
            escalation_reason=reason, ticket_id=ticket_id,
        )

    # 3c. History for short-query RAG context (re-used in section 4)
    _prior_history = get_history(conversation_id, limit=4)

    # 4. RAG retrieval
    # Short follow-up messages (< 8 words) often lack enough terms for the retriever
    # to find the right KB chunks — especially when the embedding fallback kicks in.
    # Prepend the last user message to add topic context without inflating long queries.
    _retrieval_query = user_message
    if len(user_message.split()) < 8 and _prior_history:
        # chat.py adds the current message to history before calling the agent,
        # so reversed history[0] is the current message — skip it to get the real previous turn.
        _prev_user_msgs = [h["content"] for h in reversed(_prior_history) if h["role"] == "user"]
        _prev_user = _prev_user_msgs[1] if len(_prev_user_msgs) > 1 else None
        if _prev_user:
            _retrieval_query = _prev_user + " " + user_message
    rag_chunks = retrieve_with_fallback(_retrieval_query) if collection_count() > 0 else []

    # 5. Conversation history
    history = get_history(conversation_id, limit=10)

    # 6. Build messages for Gemini
    _persona = get_ai_persona(conversation_id)
    _agent_name = _persona.get("name") or "Kai"
    if user_id is None:
        system_prompt = get_guest_system_prompt(language, agent_name=_agent_name)
    else:
        system_prompt = get_system_prompt(language, category, platform=platform, agent_name=_agent_name)

    # If the ticket is already escalated, append a context note so Gemini knows
    # the handoff is already done and stops saying "I'm connecting you now."
    from db.conversation_store import is_human_handling as _is_human_pre
    if _is_human_pre(conversation_id):
        _post_escalation_note = (
            "\n\nCONTEXT — POST-ESCALATION: This ticket has already been escalated and the customer is waiting. "
            "A human specialist has already been notified — the handoff is done, not in progress. "
            "TONE: the customer may be anxious or frustrated. Be calm, direct, and reassuring. "
            "Do NOT say 'I am connecting you', 'please hold on', or anything implying the transfer is still happening. "
            "Do NOT ask 'Is there anything else I can help you with?' — they are waiting for a specialist, not more bot help. "
            "Simply acknowledge their message, answer what you factually can, and confirm the specialist will reach out shortly."
        )
        system_prompt = system_prompt + _post_escalation_note

    augmented_message = build_user_message(user_message, rag_chunks, injected_account_data or {})

    # Convert history to Gemini format.
    # chat.py calls add_message() before calling this function, so get_history() already
    # includes the current user message as the last entry. Strip it here — augmented_message
    # below re-adds it with RAG context prepended. Sending it twice causes two consecutive
    # user messages which makes Gemini repeat its previous answer and ignore the follow-up.
    history_for_gemini = history[:-1] if history and history[-1]["role"] == "user" else history

    # Suppress self-introductions on follow-up turns.
    if history_for_gemini:
        system_prompt += "\n\nCONTEXT: This is a follow-up message in an ongoing conversation. Do NOT introduce yourself or say your name."
    gemini_history = []
    for msg in history_for_gemini:
        role = "model" if msg["role"] == "assistant" else "user"
        gemini_history.append(
            genai_types.Content(role=role, parts=[genai_types.Part(text=msg["content"])])
        )

    # 7. Call Gemini Flash with account tools
    # For categories that require live account data, force a tool call on the first turn
    # so Gemini cannot reply with a holding message before fetching the user's data.
    # "other" category: never call account tools — answer from RAG only.
    # Always start with get_user_profile for every account-specific category.
    # KYC status, account tier, and profile flags are cross-cutting — a withdrawal
    # block may be caused by a KYC rejection, and a restriction may stem from a
    # suspicious withdrawal pattern. Starting from the profile lets Gemini see the
    # full picture and connect root causes before calling any secondary tools.
    _FORCE_TOOL_CATEGORIES = {"kyc_verification", "account_restriction", "withdrawal_issue", "deposit_issue", "trade_issue", "password_2fa_reset"}
    _FORCE_TOOL_NAMES = {
        "kyc_verification": "get_user_profile",
        "account_restriction": "get_user_profile",
        "withdrawal_issue": "get_user_profile",
        "deposit_issue": "get_user_profile",
        "trade_issue": "get_user_profile",
        "password_2fa_reset": "get_user_profile",
    }
    # For guests (user_id=None), skip all tool-forcing — no account data available.
    # For authenticated users, force tool call if the category requires account data AND
    # no successful (non-escalated) bot reply exists yet.
    is_guest_session = user_id is None
    force_tool_name = None
    if not is_guest_session:
        from db.conversation_store import has_successful_bot_reply
        prior_successful_reply = has_successful_bot_reply(conversation_id) if history else False
        # When called from inside a workflow (suppress_handoff=True), the workflow's
        # account_lookup node already fetched the profile. Don't force a redundant
        # get_user_profile — let Gemini decide based on the conversation context.
        # Transaction-specific tool forcing (TX IDs, order IDs) still applies below.
        force_tool_name = (
            _FORCE_TOOL_NAMES.get(category)
            if category in _FORCE_TOOL_CATEGORIES and not prior_successful_reply and not suppress_handoff
            else None
        )

        # If the user mentions a transaction ID at any turn, force the relevant status tool
        # so Gemini is guaranteed to look it up regardless of prior replies.
        if (
            not force_tool_name
            and category == "withdrawal_issue"
            and _TX_ID_RE.search(user_message)
        ):
            force_tool_name = "get_withdrawal_status"
        if (
            not force_tool_name
            and category == "deposit_issue"
            and _TX_ID_RE.search(user_message)
        ):
            force_tool_name = "get_deposit_status"
        if (
            not force_tool_name
            and category == "trade_issue"
            and _SPOT_ORDER_RE.search(user_message)
        ):
            force_tool_name = "get_spot_orders"
        if (
            not force_tool_name
            and category == "trade_issue"
            and _FUTURES_POS_RE.search(user_message)
        ):
            force_tool_name = "get_futures_positions"

    # For "other" category or guest sessions, omit account tools entirely.
    # For all authenticated account categories, tools are always available — the overlay
    # STEP 0 instructs Gemini whether to USE them based on question type.
    is_other_category = category == "other"
    if is_other_category or is_guest_session:
        active_tool_defs = []
    elif prior_successful_reply:
        # After the first successful reply, remove get_user_profile from the tool list.
        # The profile data is already in the conversation history — re-calling the tool
        # causes the model to regenerate the same canned answer on every follow-up.
        # Other tools (get_account_restrictions, get_withdrawal_status, etc.) stay available
        # so the model can still investigate new symptoms the user reports.
        active_tool_defs = [t for t in TOOL_DEFINITIONS if t.get("name") != "get_user_profile"]
    else:
        active_tool_defs = TOOL_DEFINITIONS
    tools = [genai_types.Tool(function_declarations=active_tool_defs)] if active_tool_defs else []
    tool_config = (
        genai_types.ToolConfig(
            function_calling_config=genai_types.FunctionCallingConfig(
                mode="ANY",
                allowed_function_names=[force_tool_name],
            )
        )
        if force_tool_name
        else None
    )
    config = genai_types.GenerateContentConfig(
        system_instruction=system_prompt,
        **({"tools": tools} if tools else {}),
        **({"tool_config": tool_config} if tool_config else {}),
        max_output_tokens=MAX_TOKENS,
    )

    gemini_messages = gemini_history + [
        genai_types.Content(role="user", parts=[genai_types.Part(text=augmented_message)])
    ]
    try:
        final_response = _call_with_retry(
            lambda: client.models.generate_content(model=MODEL, contents=gemini_messages, config=config)
        )
    except Exception as e:
        ticket_id = get_ticket_id_by_conversation(conversation_id)
        from db.conversation_store import is_human_handling as _is_already_escalated
        if _is_already_escalated(conversation_id):
            # Ticket already escalated — don't re-escalate or show handoff again.
            # Return a calm holding message so the customer knows the specialist is coming.
            _hold_msg = (
                "A specialist has been notified and will be with you shortly."
                if language == "en"
                else "เจ้าหน้าที่ผู้เชี่ยวชาญได้รับแจ้งแล้วและจะติดต่อกลับในไม่ช้าค่ะ"
            )
            return AgentResponse(text=_hold_msg, language=language, escalated=False,
                                 escalation_reason="ai_service_unavailable")
        if ticket_id:
            _escalation_status = "Escalated" if platform == "email" else "pending_human"
            update_ticket_status(ticket_id, _escalation_status)
            _meta = get_ticket_meta(ticket_id)
            if _meta.get("customer_id"):
                trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))
        effective_category = detect_category_from_message(user_message) or category
        reply_text = "" if suppress_handoff else build_handoff_message(effective_category, language)
        return AgentResponse(
            text=reply_text,
            language=language, escalated=True,
            escalation_reason="ai_service_unavailable", ticket_id=ticket_id,
        )

    # 8. Handle function calls (account data lookups)
    account_data = {}

    # After a forced tool call the tool_config must be cleared so the follow-up
    # generate call can return a normal text response.
    free_config = genai_types.GenerateContentConfig(
        system_instruction=system_prompt,
        **({"tools": tools} if tools else {}),
        max_output_tokens=MAX_TOKENS,
    )

    while True:
        candidate = (
            final_response.candidates[0]
            if final_response.candidates
            else None
        )
        parts = (candidate.content.parts if candidate and candidate.content else None) or []
        fn_calls = [part.function_call for part in parts if part.function_call]
        if not fn_calls:
            break

        fn_response_parts = []
        for fn_call in fn_calls:
            tool_fn = TOOLS.get(fn_call.name)
            if tool_fn:
                kwargs = dict(fn_call.args)
                # Inject authenticated user_id — never trust tool input for this
                result = tool_fn(user_id=user_id, **kwargs)
                account_data[fn_call.name] = result
                # Backfill customer record with real profile data so the dashboard
                # shows the correct name even if _fetch_user_profile failed at
                # conversation creation time.
                if fn_call.name == "get_user_profile" and "error" not in result:
                    update_customer_from_profile(user_id, result)
                # Replace null reason-fields with explicit markers before sending to
                # Gemini — prevents the model from fabricating plausible-sounding reasons.
                sanitized_result = _sanitize_tool_result(result)
                fn_response_parts.append(
                    genai_types.Part(
                        function_response=genai_types.FunctionResponse(
                            name=fn_call.name,
                            response={"result": sanitized_result},
                        )
                    )
                )

        if not fn_response_parts:
            break

        gemini_messages = gemini_messages + [
            candidate.content,
            genai_types.Content(role="user", parts=fn_response_parts),
        ]
        try:
            # Use free_config (no forced tool) so Gemini can now reply with text
            final_response = _call_with_retry(
                lambda: client.models.generate_content(model=MODEL, contents=gemini_messages, config=free_config)
            )
        except Exception as e:
            ticket_id = get_ticket_id_by_conversation(conversation_id)
            from db.conversation_store import is_human_handling as _is_already_escalated
            if _is_already_escalated(conversation_id):
                _hold_msg = (
                    "A specialist has been notified and will be with you shortly."
                    if language == "en"
                    else "เจ้าหน้าที่ผู้เชี่ยวชาญได้รับแจ้งแล้วและจะติดต่อกลับในไม่ช้าค่ะ"
                )
                return AgentResponse(text=_hold_msg, language=language, escalated=False,
                                     escalation_reason="ai_service_unavailable")
            if ticket_id:
                _escalation_status = "Escalated" if platform == "email" else "pending_human"
                update_ticket_status(ticket_id, _escalation_status)
                _meta = get_ticket_meta(ticket_id)
                if _meta.get("customer_id"):
                    trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))
            effective_category = detect_category_from_message(user_message) or category
            reply_text = "" if suppress_handoff else build_handoff_message(effective_category, language)
            return AgentResponse(
                text=reply_text,
                language=language, escalated=True,
                escalation_reason="ai_service_unavailable", ticket_id=ticket_id,
            )

    # 9. Extract and parse Gemini's JSON response
    raw_text = ""
    final_candidate = final_response.candidates[0] if final_response.candidates else None
    final_parts = (final_candidate.content.parts if final_candidate and final_candidate.content else None) or []
    for part in final_parts:
        if hasattr(part, "text") and part.text:
            raw_text += part.text

    response_text, confidence, needs_human, resolved = _parse_gemini_response(raw_text, language)

    # 9a. Farewell override: if the model didn't set resolved=true but the reply
    # ends with an unambiguous farewell, force it. The model is reliable at choosing
    # farewell words; the resolved flag is a secondary judgment that can lag behind.
    if not resolved and not needs_human:
        resolved = _is_farewell_reply(response_text, language)

    # 10. Compliance post-filter + markdown cleanup
    response_text = post_filter(response_text)
    response_text = _clean_response(response_text)

    # 11. Escalation: Gemini's own needs_human flag OR keyword triggers
    # If the ticket is already escalated, skip re-escalation entirely — the ticket
    # is already in the queue. Just return Gemini's answer as a plain reply so the
    # customer gets a relevant response while they wait for the human agent.
    from db.conversation_store import is_human_handling as _is_human_handling
    if _is_human_handling(conversation_id):
        return AgentResponse(text=response_text, language=language, escalated=False, confidence=confidence)

    keyword_escalate, reason = should_escalate(user_message, confidence, consecutive_low_confidence)
    escalate = needs_human or keyword_escalate
    if not reason:
        reason = "model_requested" if needs_human else ("low_confidence" if confidence < 0.6 else "model_requested")

    # Guests: suppress single-turn low confidence only — everything else escalates normally.
    if escalate and is_guest_session and reason == "low_confidence":
        escalate = False

    # Trust the model's needs_human judgment over the confidence threshold when either:
    #
    # (a) No tools were available — confidence < 0.6 only means no KB chunk matched,
    #     not that the model failed to help. The model cannot fetch more data, so its
    #     needs_human=False IS its final, best assessment. Applies to "other" category
    #     (tools excluded), guest sessions (already caught above), and any future
    #     tool-free path. Sensitive keywords / explicit human requests still fire.
    #
    # (b) Follow-up turns (prior_successful_reply=True) — the model has full conversation
    #     context by this point. Low confidence on "ok thanks" or "so i can trade now?"
    #     reflects missing KB context, not inability to answer. If the model says it can
    #     handle it, trust that over a raw number.
    #
    # In both cases only the confidence-based path ("low_confidence") is suppressed.
    # Sensitive keywords, explicit human requests, and repeated-unclear-exchanges are
    # unaffected and still escalate normally.
    _no_tools = not active_tool_defs
    if escalate and reason == "low_confidence" and not needs_human and (_no_tools or prior_successful_reply):
        escalate = False

    if escalate:
        # ── Information collection phase intercept ─────────────────────────
        # Before escalating, check if we should collect more context first.
        # Applies to all users (guests and authenticated) for any model-initiated
        # escalation — collecting info/screenshot before handing off improves
        # agent context regardless of category or auth state.
        # User-requested, sensitive keywords, and service errors skip this.
        _intercept_reasons = ("model_requested", "low_confidence")
        # If the ticket is already escalated (customer following up after a prior
        # escalation), skip the collection phase — asking for a screenshot again
        # is confusing and wrong. Fall straight through to the escalation write.
        from db.conversation_store import is_human_handling as _is_human
        if _is_human(conversation_id):
            reason = "already_escalated"
        elif suppress_handoff:
            # Inside a workflow — the workflow owns escalation routing via its
            # own escalate node. Don't intercept with collection questions.
            pass
        elif reason in _intercept_reasons:
            _phase = get_info_collection_phase(conversation_id)
            if _phase is None:
                # First time we've tried to escalate — enter collection phase
                set_info_collection_phase(conversation_id, "questioning")
                # For account_restriction, detect what the user described so the
                # right collection questions are asked rather than the generic set.
                _symptom = detect_symptom_type(user_message) if category == "account_restriction" else None
                collection_text = build_collection_prompt(category, language, symptom_type=_symptom)
                return AgentResponse(
                    text=collection_text,
                    language=language,
                    escalated=False,
                    info_collection=True,
                )
            # Already in collection phase — check turn cap (max 2 collection turns)
            if count_collection_turns(conversation_id) < 2:
                # One more collection turn allowed — let the escalation proceed below
                # but the phase stays set; next attachment or decline will fire escalation
                # from chat.py. Clear the phase here so the agent doesn't re-intercept.
                pass
            # Phase is set and cap reached (or second pass) — fall through to escalate
            set_info_collection_phase(conversation_id, None)

        ticket_id = get_ticket_id_by_conversation(conversation_id)
        if ticket_id:
            _escalation_status = "Escalated" if platform == "email" else "pending_human"
            update_ticket_status(ticket_id, _escalation_status)
            _meta = get_ticket_meta(ticket_id)
            if _meta.get("customer_id"):
                trigger_auto_assign(ticket_id, category, _meta["priority"], str(_meta["customer_id"]))
        effective_category = detect_category_from_message(user_message) or category
        if suppress_handoff:
            # Workflow mode: the Escalate node handles the handoff message — don't append it here.
            reply_text = response_text if (response_text and len(response_text.strip()) > 20) else ""
        else:
            handoff = build_handoff_message(effective_category, language)
            # Always show the AI's substantive answer before the handoff — whether escalation
            # was triggered by needs_human=true or low confidence. The model was told to explain
            # first and then set needs_human, so we must honour that explanation.
            reply_text = f"{response_text}\n\n{handoff}" if (response_text and len(response_text.strip()) > 20) else handoff
        return AgentResponse(
            text=reply_text,
            language=language, escalated=True,
            escalation_reason=reason, ticket_id=ticket_id,
        )

    return AgentResponse(
        text=response_text, language=language, resolved=resolved, confidence=confidence,
        profile_fetched="get_user_profile" in account_data,
    )


_EN_FAREWELL_PHRASES = {
    "have a great day",
    "have a good day",
    "have a wonderful day",
    "have a nice day",
    "have a great one",
    "have a good one",
    "take care",
    "goodbye",
    "good luck",
    "all the best",
    "best of luck",
    "talk soon",
    "see you",
    "you're welcome",
    "you are welcome",
    "happy to help",
    "glad i could help",
    "glad to help",
    "hope that helps",
    "hope this helps",
}

# Thai farewell markers — checked against the last sentence only to prevent
# mid-conversation false positives (e.g. "good luck with your resubmission").
_TH_FAREWELL_LAST_SENTENCE = {
    "โชคดีนะ",
    "โชคดีนะคะ",
    "โชคดีนะครับ",
    "ขอให้โชคดี",
    "มีวันที่ดี",
    "วันดีๆ นะ",
    "วันดีนะ",
    "แล้วพบกันใหม่",
    "ขอให้วันนี้เป็นวันที่ดี",
}


def _is_farewell_reply(text: str, language: str) -> bool:
    """
    Return True if the reply text ends with an unambiguous farewell phrase.
    Used to override resolved=False when the model chose farewell wording
    but forgot to set the flag.
    """
    if not text:
        return False
    lower = text.lower().strip()
    if language != "th":
        # Check if any EN farewell phrase appears near the end of the reply
        for phrase in _EN_FAREWELL_PHRASES:
            if lower.endswith(phrase) or lower.endswith(phrase + "!") or lower.endswith(phrase + "."):
                return True
        return False
    else:
        # For Thai: only check the last sentence to avoid mid-conversation false positives
        sentences = [s.strip() for s in re.split(r"[.!?।\n]+", text) if s.strip()]
        last = sentences[-1] if sentences else text.strip()
        for phrase in _TH_FAREWELL_LAST_SENTENCE:
            if phrase in last:
                return True
        return False


def _parse_gemini_response(raw: str, language: str) -> tuple[str, float, bool, bool]:
    """
    Parse Gemini's structured JSON response.
    Returns (response_text, confidence, needs_human, resolved).
    Falls back gracefully if JSON is malformed.
    """
    if not raw:
        return UNABLE_TO_HELP_MESSAGES.get(language, UNABLE_TO_HELP_MESSAGES["en"]), 0.0, True, False

    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", raw.strip())

    def _try_parse(text: str):
        data = json.loads(text)
        response_text = str(data.get("response", "")).strip()
        confidence = float(data.get("confidence", ESCALATION_CONFIDENCE_THRESHOLD))
        needs_human = bool(data.get("needs_human", False))
        resolved = bool(data.get("resolved", False))
        if not response_text:
            response_text = UNABLE_TO_HELP_MESSAGES.get(language, UNABLE_TO_HELP_MESSAGES["en"])
            needs_human = True
        return response_text, confidence, needs_human, resolved

    # 1. Try the whole cleaned string as JSON
    try:
        return _try_parse(cleaned)
    except (json.JSONDecodeError, ValueError, TypeError):
        pass

    # 2. Gemini sometimes outputs prose then JSON — find the first { ... } block
    match = re.search(r'\{[^{}]*"response"[^{}]*\}', cleaned, re.DOTALL)
    if match:
        try:
            return _try_parse(match.group(0))
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    # 3. Last resort: strip any trailing JSON-looking block and use the prose
    prose = re.sub(r'\{[\s\S]*\}', '', cleaned).strip()
    if prose:
        return prose, 0.7, False, False

    return UNABLE_TO_HELP_MESSAGES.get(language, UNABLE_TO_HELP_MESSAGES["en"]), 0.0, True, False
