"""Chat API routes — user-facing message endpoint."""
import asyncio
import logging
import time
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from api.middleware.auth import get_user_id, get_optional_user_id
from api.logging_config import conversation_id_var

logger = logging.getLogger("api.chat")
from api.ws_manager import manager
from db.conversation_store import (
    init_db, create_conversation, add_message, get_history, get_paginated_history,
    assign_ai_persona, get_ai_persona, is_human_handling, has_human_agent_replied,
    update_ticket_category, get_ticket_category, count_consecutive_low_confidence,
    get_customer_id_for_user, get_customer_tickets, get_open_ticket_for_customer,
    get_ticket_by_id, update_ticket_status, get_ticket_id_by_conversation,
    get_info_collection_phase, set_info_collection_phase, count_collection_turns,
    create_emergency_ticket, get_system_signals,
)
from engine.assignment_client import trigger_auto_assign, emit_ticket_event
from workflow_engine.interceptor import workflow_interceptor as chat
from engine.mock_agents import pick_agent
from engine.prompt_templates import build_greeting

router = APIRouter(prefix="/chat", tags=["chat"])


class StartRequest(BaseModel):
    platform: str = "web"  # "freedom" | "bitazza" | "web"
    category: str | None = None  # issue category pre-selected in widget
    guest_name: str | None = None   # optional name from pre-chat identity form
    guest_email: str | None = None  # optional email from pre-chat identity form


class StartResponse(BaseModel):
    conversation_id: str
    ticket_id: str
    customer_id: str
    agent_name: str
    agent_avatar: str
    agent_avatar_url: str
    is_guest: bool = False


class GreetRequest(BaseModel):
    conversation_id: str
    language: str = "en"  # "en" | "th"


class GreetResponse(BaseModel):
    greeting: str
    language: str
    bot_name: str
    agent_avatar: str | None = None
    agent_avatar_url: str | None = None


class MessageRequest(BaseModel):
    conversation_id: str
    message: str
    language: str | None = None  # session language set when user picked EN/TH in widget
    consecutive_low_confidence: int = 0  # deprecated — server computes this now; kept for backwards compatibility
    category: str | None = None  # issue category selected by user in widget
    attachment_ids: list[str] | None = None  # UUIDs returned by POST /api/uploads/attachment


class AttachmentMeta(BaseModel):
    id: str
    url: str
    name: str
    mime_type: str
    size: int


class MessageResponse(BaseModel):
    reply: str | None  # None means a human agent is handling — widget must not render a bot bubble
    language: str
    escalated: bool
    ticket_id: str | None = None
    agent_name: str | None = None
    agent_avatar: str | None = None
    agent_avatar_url: str | None = None
    offer_resolution: bool = False
    specialist_intro: str | None = None  # First message from the incoming specialist agent
    upgraded_category: str | None = None  # Set when mid-convo specialist handoff occurred
    transition_message: str | None = None  # Outgoing-agent farewell shown before specialist reply
    quick_replies: list[str] = []


@router.post("/start", response_model=StartResponse)
async def start_conversation(body: StartRequest, user_id: str | None = Depends(get_optional_user_id)):
    import time as _time
    init_db()
    is_guest = user_id is None
    cid = create_conversation(
        user_id=user_id,
        platform=body.platform,
        issue_category=body.category,
        is_guest=is_guest,
        guest_name=body.guest_name,
        guest_email=body.guest_email,
    )
    agent = pick_agent(body.category)
    assign_ai_persona(cid, agent["name"], agent["avatar"], agent["avatar_url"])
    tid = cid  # ticket already created by create_conversation; no status change needed
    logger.info("conversation_started", extra={
        "conv_id": cid, "platform": body.platform,
        "category": body.category, "is_guest": is_guest,
    })
    customer_display_name = body.guest_name or "Guest" if is_guest else "—"
    await manager.broadcast_all({
        "type": "new_ticket",
        "ticket": {
            "id": tid,
            "status": "Open_Live",
            "channel": body.platform if body.platform in ("web", "line", "facebook", "email") else "web",
            "category": body.category,
            "priority": 3,
            "assigned_to": None,
            "assigned_agent_id": None,
            "tags": [],
            "last_message": None,
            "last_message_at": None,
            "created_at": int(_time.time()),
            "updated_at": int(_time.time()),
            "customer": {"id": user_id or "guest", "name": customer_display_name, "tier": "Standard"},
        },
    })
    if is_guest:
        customer_id = cid  # use ticket id as a stable reference for guest sessions
    else:
        customer_id = get_customer_id_for_user(user_id) or user_id
    return StartResponse(
        conversation_id=cid,
        ticket_id=tid,
        customer_id=customer_id,
        agent_name=agent["name"],
        agent_avatar=agent["avatar"],
        agent_avatar_url=agent["avatar_url"],
        is_guest=is_guest,
    )


class SetCategoryRequest(BaseModel):
    conversation_id: str
    category: str


class SetCategoryResponse(BaseModel):
    agent_name: str
    agent_avatar: str
    agent_avatar_url: str


_CATEGORY_LABEL: dict[str, str] = {
    "kyc_verification":    "KYC Verification",
    "account_restriction": "Account Restriction",
    "password_2fa_reset":  "Password / 2FA Reset",
    "fraud_security":      "Fraud & Security",
    "withdrawal_issue":    "Withdrawal Issue",
    "other":               "Other",
}


@router.post("/set-category", response_model=SetCategoryResponse)
def set_category(body: SetCategoryRequest, user_id: str | None = Depends(get_optional_user_id)):
    """
    Called when the user selects an issue category in the widget.
    Re-assigns the AI persona to the specialist agent for that category
    and updates the ticket category for the dashboard.
    If the ticket already has a category (customer went back and re-picked),
    inserts a system message so agents can see the topic switch in the thread.
    """
    existing = get_ticket_category(body.conversation_id)
    if existing and existing not in ("unclassified", body.category):
        old_label = _CATEGORY_LABEL.get(existing, existing.replace("_", " ").title())
        new_label = _CATEGORY_LABEL.get(body.category, body.category.replace("_", " ").title())
        add_message(body.conversation_id, "system",
                    f"── Customer switched topic: {old_label} → {new_label} ──")
    agent = pick_agent(body.category)
    assign_ai_persona(body.conversation_id, agent["name"], agent["avatar"], agent["avatar_url"])
    update_ticket_category(body.conversation_id, body.category)
    return SetCategoryResponse(
        agent_name=agent["name"],
        agent_avatar=agent["avatar"],
        agent_avatar_url=agent["avatar_url"],
    )


@router.post("/greet", response_model=GreetResponse)
def greet(body: GreetRequest, user_id: str | None = Depends(get_optional_user_id)):
    """
    Called immediately after language selection.
    Returns the AI bot's introduction message and persists it as the first assistant message.
    """
    lang = body.language if body.language in ("en", "th") else "en"
    persona = get_ai_persona(body.conversation_id)
    from engine.mock_agents import _AGENTS_BY_NAME
    gender = _AGENTS_BY_NAME.get(persona["name"] or "", {}).get("gender", "f")
    greeting = build_greeting(persona["name"], lang, gender)
    add_message(body.conversation_id, "assistant", greeting)
    return GreetResponse(
        greeting=greeting,
        language=lang,
        bot_name=persona["name"],
        agent_avatar=persona["avatar"],
        agent_avatar_url=persona["avatar_url"],
    )


class EmergencyEscalateRequest(BaseModel):
    error_source: str                   # "start_failed"
    platform: str = "web"
    language: str = "en"
    guest_name: str | None = None
    guest_email: str | None = None
    user_message: str | None = None     # any message the customer had typed before failure


class EmergencyEscalateResponse(BaseModel):
    conversation_id: str
    ticket_id: str
    escalated: bool = True


@router.post("/emergency-escalate", response_model=EmergencyEscalateResponse)
def emergency_escalate(body: EmergencyEscalateRequest):
    """
    Called by the widget when startConversation() fails on both attempts.
    Creates a guest ticket with status=Escalated immediately and triggers
    auto-assign so a human agent picks it up.
    No auth required — the widget cannot authenticate if start failed.
    """
    # Import inside the function so monkeypatching in tests can intercept these calls.
    import db.conversation_store as _cs
    import engine.assignment_client as _ac

    try:
        ticket_id = _cs.create_emergency_ticket(
            platform=body.platform,
            error_source=body.error_source,
            guest_name=body.guest_name,
            guest_email=body.guest_email,
            user_message=body.user_message,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to create emergency ticket") from exc
    _ac.trigger_auto_assign(ticket_id, "unclassified", 3, ticket_id)
    return EmergencyEscalateResponse(
        conversation_id=ticket_id,
        ticket_id=ticket_id,
    )


def _resolve_attachments(attachment_ids: list[str] | None, base_url: str = "") -> list[dict]:
    """
    Resolve attachment UUIDs to their stored metadata.
    Reads the uploads/attachments directory to find matching files and rebuilds metadata.
    Returns a list of dicts with {id, url, name, mime_type, size}.
    base_url should be the Python API origin (e.g. http://localhost:8000) so the URL
    is absolute and works from any client (widget, dashboard, email).
    """
    if not attachment_ids:
        return []
    import os, mimetypes
    upload_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "uploads", "attachments",
    )
    if not os.path.isdir(upload_dir):
        return []
    result = []
    for aid in attachment_ids:
        # Files are stored as <uuid>_<name>
        matches = [f for f in os.listdir(upload_dir) if f.startswith(aid + "_")]
        if not matches:
            continue
        fname = matches[0]
        fpath = os.path.join(upload_dir, fname)
        safe_name = fname[len(aid) + 1:]
        mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        size = os.path.getsize(fpath)
        url = f"{base_url}/uploads/attachments/{fname}"
        result.append({"id": aid, "url": url, "name": safe_name, "mime_type": mime, "size": size})
    return result


@router.post("/message", response_model=MessageResponse)
async def send_message(request: Request, body: MessageRequest, user_id: str | None = Depends(get_optional_user_id)):
    if not body.message.strip() and not body.attachment_ids:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Reject messages on closed tickets — hoisted early so add_message is never called
    _ticket = get_ticket_by_id(body.conversation_id)
    if _ticket and _ticket.get("status") in ("Closed_Resolved", "Closed_Unresponsive"):
        raise HTTPException(status_code=403, detail="This conversation is closed.")

    # Set conv_id ContextVar so all downstream logs (agent, workflow) carry it
    _token_conv = conversation_id_var.set(body.conversation_id)
    logger.info("message_received", extra={
        "conv_id": body.conversation_id,
        "language": body.language,
        "category": body.category,
        "has_attachments": bool(body.attachment_ids),
        "is_guest": user_id is None,
    })

    # Intent resolution: on the first user turn, refine the picked category using
    # the message content so that deposit_issue / trade_issue (which have no widget
    # card) and mis-picked categories are routed correctly from the very start.
    # Only runs once — subsequent turns use the category stored in the ticket.
    _prior_history = get_history(body.conversation_id, limit=10)
    _first_user_turn = not any(m["role"] == "user" for m in _prior_history)
    _intent_resolved_agent: dict | None = None
    effective_category = body.category
    if _first_user_turn and body.category:
        from engine.intent_resolver import classify_intent
        effective_category = classify_intent(body.category, body.message)
        if effective_category != body.category:
            update_ticket_category(body.conversation_id, effective_category)
            _intent_resolved_agent = pick_agent(effective_category)
            assign_ai_persona(
                body.conversation_id,
                _intent_resolved_agent["name"],
                _intent_resolved_agent["avatar"],
                _intent_resolved_agent["avatar_url"],
            )

    # Resolve any attachment IDs to metadata (absolute URL so both widget and dashboard can load them)
    _base_url = str(request.base_url).rstrip("/")
    _attachments = _resolve_attachments(body.attachment_ids, _base_url)

    # Persist user message (with attachments in metadata if present)
    _user_msg_id = add_message(
        body.conversation_id,
        "user",
        body.message,
        attachments=_attachments if _attachments else None,
    )
    # Emit to dashboard so agents see the customer's message in real-time
    _now_ts = int(time.time())
    asyncio.create_task(emit_ticket_event(body.conversation_id, "new_message", {
        "message": {
            "id": _user_msg_id,
            "role": "user",
            "sender_type": "customer",
            "content": body.message,
            "created_at": _now_ts,
            "channel": "widget",
            **({"attachments": _attachments} if _attachments else {}),
        },
    }))

    # Guard: once a human agent has sent their first reply, the AI must not reply.
    # Before that first reply, even escalated tickets can still get AI answers —
    # the customer may ask follow-up questions while waiting for the agent.
    # reply=None tells the widget to suppress the bot bubble entirely.
    # Cache this once — used again below to prevent status downgrades.
    _already_escalated = is_human_handling(body.conversation_id)
    if _already_escalated and has_human_agent_replied(body.conversation_id):
        # Notify the assigned agent that the customer sent a new message
        ticket = _ticket  # already fetched at top of handler — reuse
        assigned_to = str(ticket["assigned_to"]) if ticket and ticket.get("assigned_to") else None
        if assigned_to:
            from engine.notifications import create_notification
            snippet = body.message[:80] + ("…" if len(body.message) > 80 else "")
            notif = create_notification(
                user_id=assigned_to,
                role="agent",
                type="customer_reply",
                priority="high",
                title=f"Customer replied — Ticket #{body.conversation_id[:8]}",
                body=snippet,
                ticket_id=body.conversation_id,
            )
            await manager.broadcast_all({"type": "notification:new", "notification": notif})
        return MessageResponse(
            reply=None,
            language="en",
            escalated=True,
        )

    # If escalated but no human reply yet — still notify the agent but let the AI continue.
    if _already_escalated:
        ticket = get_ticket_by_id(body.conversation_id)
        assigned_to = str(ticket["assigned_to"]) if ticket and ticket.get("assigned_to") else None
        if assigned_to:
            from engine.notifications import create_notification
            snippet = body.message[:80] + ("…" if len(body.message) > 80 else "")
            notif = create_notification(
                user_id=assigned_to,
                role="agent",
                type="customer_reply",
                priority="high",
                title=f"Customer replied — Ticket #{body.conversation_id[:8]}",
                body=snippet,
                ticket_id=body.conversation_id,
            )
            await manager.broadcast_all({"type": "notification:new", "notification": notif})

    # Compute consecutive low-confidence count server-side — not trusted from client
    consecutive_low = count_consecutive_low_confidence(body.conversation_id)

    # Mark ticket In_Progress while the AI is actively processing this turn.
    # This distinguishes "AI is working" from "waiting on customer" in the queue.
    # Skip if already escalated — never downgrade Escalated → In_Progress.
    _ticket_id = get_ticket_id_by_conversation(body.conversation_id)
    if _ticket_id and not _already_escalated:
        update_ticket_status(_ticket_id, "in_progress")
        asyncio.create_task(emit_ticket_event(_ticket_id, "status_change", {"status": "In_Progress"}))

    # ── Attachment escalation ──────────────────────────────────────────────────
    # If the user sent an attachment, escalate immediately — AI never reads files.
    # Also fires if the user is in the collection phase and attaches or declines.
    _collection_phase = get_info_collection_phase(body.conversation_id)
    _NO_SCREENSHOT_PHRASES = [
        "can't send", "cannot send", "no screenshot", "don't have", "don't have it",
        "ไม่มี", "ไม่สามารถ", "ส่งไม่ได้", "ไม่มีรูป",
    ]
    _user_declined_screenshot = any(
        p in body.message.lower() for p in _NO_SCREENSHOT_PHRASES
    )
    _force_escalate = bool(_attachments) or (
        _collection_phase is not None and _user_declined_screenshot
    )

    if _force_escalate:
        logger.info("attachment_escalation", extra={
            "conv_id": body.conversation_id,
            "reason": "attachment" if _attachments else "screenshot_declined",
            "category": effective_category,
        })
        # Clear collection phase — handoff is happening now
        if _collection_phase is not None:
            set_info_collection_phase(body.conversation_id, None)
        if _ticket_id:
            update_ticket_status(_ticket_id, "pending_human")
            from db.conversation_store import get_ticket_meta
            from engine.assignment_client import trigger_auto_assign
            _meta = get_ticket_meta(_ticket_id)
            if _meta.get("customer_id"):
                trigger_auto_assign(_ticket_id, effective_category, _meta["priority"], str(_meta["customer_id"]))
        from engine.prompt_templates import build_attachment_handoff_message
        from engine.agent import detect_language
        _lang = body.language if body.language in ("en", "th") else (detect_language(body.message) if body.message.strip() else "en")
        _reply_text = build_attachment_handoff_message(bool(_attachments), _lang)
        _bot_msg_id = add_message(body.conversation_id, "assistant", _reply_text, {"escalated": True, "escalation_reason": "attachment"})
        update_ticket_status(_ticket_id, "pending_human")
        asyncio.create_task(emit_ticket_event(body.conversation_id, "new_message", {
            "message": {"id": _bot_msg_id, "role": "assistant", "sender_type": "bot", "content": _reply_text, "created_at": int(time.time())},
        }))
        asyncio.create_task(emit_ticket_event(_ticket_id, "status_change", {"status": "Pending_Human"}))
        conversation_id_var.reset(_token_conv)
        return MessageResponse(
            reply=_reply_text,
            language=_lang,
            escalated=True,
            ticket_id=_ticket_id,
        )

    # ── Run agent ─────────────────────────────────────────────────────────────
    # workflow_interceptor is sync+blocking (Gemini HTTP calls inside);
    # run in a thread pool to avoid blocking the event loop.
    result = await asyncio.to_thread(
        chat,
        conversation_id=body.conversation_id,
        user_id=user_id,
        user_message=body.message,
        consecutive_low_confidence=consecutive_low,
        category=effective_category,
        override_language=body.language if body.language in ("en", "th") else None,
    )

    # If the agent detected a mid-conversation category upgrade, update the DB persona
    # and ticket category so the dashboard and future messages use the specialist.
    if result.upgraded_category:
        from engine.mock_agents import pick_agent as _pick_agent
        specialist = _pick_agent(result.upgraded_category)
        assign_ai_persona(body.conversation_id, specialist["name"], specialist["avatar"], specialist["avatar_url"])
        update_ticket_category(body.conversation_id, result.upgraded_category)

    # Guard: if the workflow engine produced no reply (e.g. a resume path that only
    # ran condition/account_lookup/set_variable nodes with no send_reply or ai_reply),
    # output_reply stays None and becomes "" in interceptor.py. Suppress the empty
    # bubble rather than persisting it — the customer already saw the prior message.
    if not result.text:
        logger.warning(
            "empty_bot_reply suppressed",
            extra={"conv_id": body.conversation_id, "category": effective_category},
        )
        conversation_id_var.reset(_token_conv)
        return MessageResponse(reply=None, language=result.language or "en", escalated=result.escalated)

    # Persist assistant reply — include confidence so server-side counter can read it
    _reply_meta: dict = {
        "escalated": result.escalated,
        "escalation_reason": result.escalation_reason,
        "confidence": result.confidence,
    }
    if getattr(result, "info_collection", False):
        _reply_meta["info_collection"] = True
    if getattr(result, "profile_fetched", False):
        _reply_meta["profile_fetched"] = True
    _bot_msg_id = add_message(body.conversation_id, "assistant", result.text, _reply_meta)
    asyncio.create_task(emit_ticket_event(body.conversation_id, "new_message", {
        "message": {"id": _bot_msg_id, "role": "assistant", "sender_type": "bot", "content": result.text, "created_at": int(time.time())},
    }))

    # After the AI replies, move status to Pending_Customer (ball is in customer's court).
    # Skip if the AI escalated — agent.py already wrote the correct Escalated status.
    # Also skip if the ticket was already escalated before this turn — never downgrade.
    # Also skip if escalation_reason is set — this means an AI node escalated (e.g.
    # ai_service_unavailable) but the workflow paused before reaching EscalateNode,
    # so execution.escalated is still False. agent.py already set Escalated status
    # and called trigger_auto_assign; overwriting with Pending_Customer would lose that.
    _ai_escalated = result.escalated or bool(result.escalation_reason)
    if not _ai_escalated and _ticket_id and not _already_escalated:
        update_ticket_status(_ticket_id, "pending_customer")
        asyncio.create_task(emit_ticket_event(_ticket_id, "status_change", {"status": "Pending_Customer"}))
    elif _ai_escalated and _ticket_id and not _already_escalated:
        asyncio.create_task(emit_ticket_event(_ticket_id, "status_change", {"status": "Pending_Human"}))

    # Merge intent-resolver agent update with any mid-conversation upgrade from the agent.
    # result fields take precedence (agent upgrade is more specific).
    _final_agent_name = result.agent_name or (_intent_resolved_agent["name"] if _intent_resolved_agent else None)
    _final_agent_avatar = result.agent_avatar or (_intent_resolved_agent["avatar"] if _intent_resolved_agent else None)
    _final_agent_avatar_url = result.agent_avatar_url or (_intent_resolved_agent["avatar_url"] if _intent_resolved_agent else None)
    _final_upgraded_category = result.upgraded_category or (effective_category if _intent_resolved_agent else None)

    # Quick-reply pills: read admin config once per request (cheap — single DB query)
    from db.conversation_store import get_bot_config as _get_bot_config
    from engine.quick_reply_defaults import select_curated_pills
    _cfg = _get_bot_config()
    _pills_enabled = _cfg.get("quick_replies_enabled", True)
    _pills_mode    = _cfg.get("quick_replies_mode", "ai")
    if not _pills_enabled or result.escalated or result.resolved:
        _quick_replies: list[str] = []
    elif _pills_mode == "curated":
        # Smart curated: LLM picks 2-3 from the admin's pool based on context
        _quick_replies = select_curated_pills(
            effective_category, result.language,
            bot_reply=result.text or "", user_message=body.message,
        )
    else:
        # AI mode: use Gemini-generated pills; fall back to smart curated
        # when Gemini returns empty despite being on a non-escalation turn.
        _ai_pills = getattr(result, "quick_replies", None) or []
        _quick_replies = _ai_pills if _ai_pills else select_curated_pills(
            effective_category, result.language,
            bot_reply=result.text or "", user_message=body.message,
        )

    logger.info("response_sent", extra={
        "conv_id": body.conversation_id,
        "escalated": result.escalated,
        "escalation_reason": result.escalation_reason,
        "resolved": result.resolved,
        "language": result.language,
        "upgraded_category": result.upgraded_category,
    })
    conversation_id_var.reset(_token_conv)
    return MessageResponse(
        reply=result.text,
        language=result.language,
        escalated=result.escalated,
        ticket_id=result.ticket_id,
        agent_name=_final_agent_name,
        agent_avatar=_final_agent_avatar,
        agent_avatar_url=_final_agent_avatar_url,
        offer_resolution=result.resolved,
        specialist_intro=result.specialist_intro,
        upgraded_category=_final_upgraded_category,
        transition_message=getattr(result, 'transition_message', None),
        quick_replies=_quick_replies,
    )


class CSATRequest(BaseModel):
    ticket_id: str
    score: int  # 1–5


@router.post("/csat")
def submit_csat(body: CSATRequest, user_id: str | None = Depends(get_optional_user_id)):
    if not 1 <= body.score <= 5:
        raise HTTPException(status_code=400, detail="Score must be between 1 and 5")
    from db.conversation_store import submit_csat_score
    submit_csat_score(body.ticket_id, body.score)
    return {"ok": True}


@router.get("/history/{conversation_id}")
def get_conversation_history(
    conversation_id: str,
    page: int | None = None,
    limit: int | None = None,
    user_id: str | None = Depends(get_optional_user_id),
):
    if page is not None and limit is not None:
        history = get_paginated_history(conversation_id, page=page, limit=limit)
    else:
        history = get_history(conversation_id, limit=50)
    signals = get_system_signals(conversation_id)
    combined = sorted(history + signals, key=lambda m: m["created_at"])
    _ticket = get_ticket_by_id(conversation_id)
    _human_handling = bool(_ticket and (_ticket.get("status") == "Escalated" or _ticket.get("assigned_to")))
    return {
        "history": combined,
        "human_handling": _human_handling,
        "ticket_status": _ticket["status"] if _ticket else None,
    }


@router.get("/customer-tickets")
def list_customer_tickets(
    page: int = 1,
    limit: int = 10,
    user_id: str = Depends(get_user_id),  # strict — guests get 401 automatically
):
    tickets = get_customer_tickets(user_id, page=page, limit=limit)
    return {"tickets": tickets}


@router.get("/open-ticket")
def get_open_ticket(user_id: str | None = Depends(get_optional_user_id)):
    if user_id is None:
        return {"ticket": None}
    ticket = get_open_ticket_for_customer(user_id)
    return {"ticket": ticket}


@router.websocket("/ws/{conversation_id}")
async def widget_ws(websocket: WebSocket, conversation_id: str):
    """
    Widget subscribes here after starting a conversation.
    When a human agent replies, the dashboard broadcasts a `new_message` event
    which is forwarded here — the widget renders it without polling.
    """
    await manager.connect_widget(websocket, conversation_id)
    try:
        while True:
            # Keep connection alive; widget sends pings as {"type": "ping"}
            data = await websocket.receive_json()
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect_widget(websocket, conversation_id)
