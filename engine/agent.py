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
    get_system_prompt, build_user_message,
    build_handoff_message, ESCALATION_MESSAGES, UNABLE_TO_HELP_MESSAGES,
)
from engine.mock_agents import pick_agent, detect_category_from_message, get_intro_message
from db.conversation_store import (
    get_history, add_message, create_ticket,
    get_ai_persona, update_ticket_status,
    get_ticket_id_by_conversation, update_customer_from_profile,
)
from db.vector_store import collection_count

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


_LANG_KEYWORDS_TH = ["ขอ", "คุณ", "ไม่", "ได้", "ว่า", "ใน", "และ", "มี", "การ", "ที่"]


def detect_language(text: str) -> str:
    """Simple Thai detection by Unicode range. Defaults to English."""
    thai_chars = sum(1 for c in text if "\u0e00" <= c <= "\u0e7f")
    return "th" if thai_chars / max(len(text), 1) > 0.1 else "en"


class AgentResponse:
    def __init__(self, text: str, language: str, escalated: bool = False,
                 escalation_reason: str = "", ticket_id: str | None = None,
                 agent_name: str | None = None, agent_avatar: str | None = None,
                 agent_avatar_url: str | None = None, resolved: bool = False,
                 specialist_intro: str | None = None, confidence: float = 1.0,
                 upgraded_category: str | None = None,
                 transition_message: str | None = None):
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


_UPGRADE_TRANSITION_MESSAGES: dict[str, dict[str, str]] = {
    "kyc_verification": {
        "en": "For KYC and identity verification questions I'll hand you over to {specialist} — our verification specialist. They'll have our full conversation and can pull up your case directly. One moment! 🪪",
        "th": "สำหรับเรื่อง KYC และการยืนยันตัวตน ขอส่งต่อให้ {specialist} ผู้เชี่ยวชาญด้านการยืนยันตัวตนของเรานะคะ เขาจะเห็นการสนทนาทั้งหมดและดึงข้อมูลเคสของคุณได้โดยตรงเลยค่ะ รอสักครู่นะคะ 🪪",
    },
    "withdrawal_issue": {
        "en": "Withdrawal questions are best handled by {specialist} — our withdrawal specialist who can trace transactions directly. Passing you over now, they'll have everything we've discussed! 💸",
        "th": "เรื่องการถอนเงินให้ {specialist} ผู้เชี่ยวชาญด้านการถอนเงินของเราจัดการดีกว่าค่ะ เขาสามารถติดตามธุรกรรมได้โดยตรงเลย กำลังส่งต่อให้เดี๋ยวนี้เลยค่ะ 💸",
    },
    "account_restriction": {
        "en": "Account restriction cases need a senior specialist — let me bring in {specialist} who can investigate and take action on your account directly. They'll be right with you! 🔒",
        "th": "เคสบัญชีถูกระงับต้องใช้ผู้เชี่ยวชาญอาวุโสค่ะ ขอให้ {specialist} มาช่วยซึ่งสามารถตรวจสอบและดำเนินการกับบัญชีของคุณได้โดยตรงเลยนะคะ 🔒",
    },
}


# Keywords that signal the user is asking about a specific account domain
# mid-conversation (e.g. while chatting in "other" category).
_UPGRADE_KEYWORDS: dict[str, list[str]] = {
    "kyc_verification":    ["kyc", "verify", "verification", "identity", "id check", "document", "passport",
                            "selfie", "ยืนยัน", "ตัวตน", "kyc status", "my kyc"],
    "account_restriction": ["restricted", "suspended", "blocked", "locked", "freeze", "restriction",
                            "ระงับ", "บล็อก", "account status", "why is my account"],
    "withdrawal_issue":    ["withdraw", "withdrawal", "transfer out", "stuck withdrawal", "pending withdrawal",
                            "ถอน", "โอนเงิน", "my withdrawal"],
}

_UPGRADEABLE_FROM = {"other"}  # only upgrade when current category is one of these

# Matches platform transaction IDs (TXN-001, TXN-9999) and blockchain tx hashes (0x…).
# Used to detect when a user provides a specific transaction reference mid-conversation
# so the agent can be forced to look it up regardless of conversation turn.
_TX_ID_RE = re.compile(r'\bTXN-\w[\w-]*|0x[0-9a-fA-F]{10,}', re.IGNORECASE)


def _detect_upgrade(message: str, current_category: str | None) -> str | None:
    """
    If the user is in a generic category and their message clearly signals a specific
    account domain, return the target category key. Otherwise return None.
    """
    if current_category not in _UPGRADEABLE_FROM:
        return None
    msg = message.lower()
    for category, keywords in _UPGRADE_KEYWORDS.items():
        if any(kw in msg for kw in keywords):
            return category
    return None


def chat(
    conversation_id: str,
    user_id: str,
    user_message: str,
    platform: str = "web",
    consecutive_low_confidence: int = 0,
    category: str | None = None,
    suppress_handoff: bool = False,
) -> AgentResponse:
    """
    Process a user message and return an AgentResponse.
    Caller is responsible for persisting messages via conversation_store.
    """
    language = detect_language(user_message)

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
    _ACCOUNT_CATEGORIES = {"kyc_verification", "account_restriction", "withdrawal_issue"}
    if category in _ACCOUNT_CATEGORIES and not suppress_handoff:
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
            return AgentResponse(
                text=build_handoff_message(category, language),
                language=language,
                escalated=True,
                escalation_reason="no_active_workflow",
                ticket_id=ticket_id if ticket_id else None,
            )

    # 3a. Mid-conversation category upgrade detection
    # If the user is in "other" but asks about KYC / withdrawals / account restrictions,
    # transparently re-route to the dedicated specialist agent for that category.
    upgrade = _detect_upgrade(user_message, category)
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
        effective_category = detect_category_from_message(user_message) or category
        reply_text = "" if suppress_handoff else build_handoff_message(effective_category, language)
        return AgentResponse(
            text=reply_text,
            language=language, escalated=True,
            escalation_reason=reason, ticket_id=ticket_id,
        )

    # 4. RAG retrieval
    rag_chunks = retrieve_with_fallback(user_message) if collection_count() > 0 else []

    # 5. Conversation history
    history = get_history(conversation_id, limit=10)

    # 6. Build messages for Gemini
    system_prompt = get_system_prompt(language, category, platform=platform)
    augmented_message = build_user_message(user_message, rag_chunks, {})

    # Convert history to Gemini format
    gemini_history = []
    for msg in history:
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
    _FORCE_TOOL_CATEGORIES = {"kyc_verification", "account_restriction", "withdrawal_issue"}
    _FORCE_TOOL_NAMES = {
        "kyc_verification": "get_user_profile",
        "account_restriction": "get_user_profile",
        "withdrawal_issue": "get_user_profile",
    }
    # Force tool call if the category requires account data AND no successful (non-escalated)
    # bot reply exists yet. This handles retries where the first turn escalated before
    # the tool could answer — without this, Gemini skips the tool and gives a holding message.
    from db.conversation_store import has_successful_bot_reply
    prior_successful_reply = has_successful_bot_reply(conversation_id) if history else False
    force_tool_name = (
        _FORCE_TOOL_NAMES.get(category)
        if category in _FORCE_TOOL_CATEGORIES and not prior_successful_reply
        else None
    )

    # If the user mentions a transaction ID at any turn in a withdrawal conversation,
    # force get_withdrawal_status so Gemini is guaranteed to look it up.
    # This overrides the prior_successful_reply guard for tx_id messages only.
    if (
        not force_tool_name
        and category == "withdrawal_issue"
        and _TX_ID_RE.search(user_message)
    ):
        force_tool_name = "get_withdrawal_status"

    # For "other" category, omit account tools entirely so Gemini cannot call them.
    is_other_category = category == "other"
    tools = [] if is_other_category else [genai_types.Tool(function_declarations=TOOL_DEFINITIONS)]
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
        if ticket_id:
            _escalation_status = "Escalated" if platform == "email" else "pending_human"
            update_ticket_status(ticket_id, _escalation_status)
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
                fn_response_parts.append(
                    genai_types.Part(
                        function_response=genai_types.FunctionResponse(
                            name=fn_call.name,
                            response={"result": result},
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
            if ticket_id:
                _escalation_status = "Escalated" if platform == "email" else "pending_human"
                update_ticket_status(ticket_id, _escalation_status)
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

    # 10. Compliance post-filter
    response_text = post_filter(response_text)

    # 11. Escalation: Gemini's own needs_human flag OR keyword triggers
    keyword_escalate, reason = should_escalate(user_message, confidence, consecutive_low_confidence)
    escalate = needs_human or keyword_escalate
    if not reason:
        reason = "low_confidence" if confidence < 0.6 else "model_requested"

    if escalate:
        ticket_id = get_ticket_id_by_conversation(conversation_id)
        if ticket_id:
            _escalation_status = "Escalated" if platform == "email" else "pending_human"
            update_ticket_status(ticket_id, _escalation_status)
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

    return AgentResponse(text=response_text, language=language, resolved=resolved, confidence=confidence)


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
