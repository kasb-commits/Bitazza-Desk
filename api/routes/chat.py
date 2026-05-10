"""Chat API routes — user-facing message endpoint."""
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from api.middleware.auth import get_user_id
from api.ws_manager import manager
from db.conversation_store import (
    init_db, create_conversation, add_message, get_history, get_paginated_history,
    assign_ai_persona, get_ai_persona, is_human_handling, has_human_agent_replied,
    update_ticket_category, count_consecutive_low_confidence,
    get_customer_id_for_user, get_customer_tickets, get_open_ticket_for_customer,
    get_ticket_by_id, update_ticket_status, get_ticket_id_by_conversation,
)
from workflow_engine.interceptor import workflow_interceptor as chat
from engine.mock_agents import pick_agent
from engine.prompt_templates import build_greeting

router = APIRouter(prefix="/chat", tags=["chat"])


class StartRequest(BaseModel):
    platform: str = "web"  # "freedom" | "bitazza" | "web"
    category: str | None = None  # issue category pre-selected in widget


class StartResponse(BaseModel):
    conversation_id: str
    ticket_id: str
    customer_id: str
    agent_name: str
    agent_avatar: str
    agent_avatar_url: str


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
    consecutive_low_confidence: int = 0  # deprecated — server computes this now; kept for backwards compatibility
    category: str | None = None  # issue category selected by user in widget


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


@router.post("/start", response_model=StartResponse)
async def start_conversation(body: StartRequest, user_id: str = Depends(get_user_id)):
    import time as _time
    init_db()
    cid = create_conversation(user_id=user_id, platform=body.platform, issue_category=body.category)
    agent = pick_agent(body.category)
    assign_ai_persona(cid, agent["name"], agent["avatar"], agent["avatar_url"])
    tid = cid  # ticket already created by create_conversation; no status change needed
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
            "customer": {"id": user_id, "name": "—", "tier": "Standard"},
        },
    })
    customer_id = get_customer_id_for_user(user_id) or user_id
    return StartResponse(
        conversation_id=cid,
        ticket_id=tid,
        customer_id=customer_id,
        agent_name=agent["name"],
        agent_avatar=agent["avatar"],
        agent_avatar_url=agent["avatar_url"],
    )


class SetCategoryRequest(BaseModel):
    conversation_id: str
    category: str


class SetCategoryResponse(BaseModel):
    agent_name: str
    agent_avatar: str
    agent_avatar_url: str


@router.post("/set-category", response_model=SetCategoryResponse)
def set_category(body: SetCategoryRequest, user_id: str = Depends(get_user_id)):
    """
    Called when the user selects an issue category in the widget.
    Re-assigns the AI persona to the specialist agent for that category
    and updates the ticket category for the dashboard.
    """
    agent = pick_agent(body.category)
    assign_ai_persona(body.conversation_id, agent["name"], agent["avatar"], agent["avatar_url"])
    update_ticket_category(body.conversation_id, body.category)
    return SetCategoryResponse(
        agent_name=agent["name"],
        agent_avatar=agent["avatar"],
        agent_avatar_url=agent["avatar_url"],
    )


@router.post("/greet", response_model=GreetResponse)
def greet(body: GreetRequest, user_id: str = Depends(get_user_id)):
    """
    Called immediately after language selection.
    Returns the AI bot's introduction message and persists it as the first assistant message.
    """
    lang = body.language if body.language in ("en", "th") else "en"
    persona = get_ai_persona(body.conversation_id)
    greeting = build_greeting(persona["name"], lang)
    add_message(body.conversation_id, "assistant", greeting)
    return GreetResponse(
        greeting=greeting,
        language=lang,
        bot_name=persona["name"],
        agent_avatar=persona["avatar"],
        agent_avatar_url=persona["avatar_url"],
    )


@router.post("/message", response_model=MessageResponse)
async def send_message(body: MessageRequest, user_id: str = Depends(get_user_id)):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

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

    # Persist user message
    add_message(body.conversation_id, "user", body.message)

    # Guard: once a human agent has sent their first reply, the AI must not reply.
    # Before that first reply, even escalated tickets can still get AI answers —
    # the customer may ask follow-up questions while waiting for the agent.
    # reply=None tells the widget to suppress the bot bubble entirely.
    if is_human_handling(body.conversation_id) and has_human_agent_replied(body.conversation_id):
        # Notify the assigned agent that the customer sent a new message
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
        return MessageResponse(
            reply=None,
            language="en",
            escalated=True,
        )

    # If escalated but no human reply yet — still notify the agent but let the AI continue.
    if is_human_handling(body.conversation_id):
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
    _ticket_id = get_ticket_id_by_conversation(body.conversation_id)
    if _ticket_id:
        update_ticket_status(_ticket_id, "in_progress")

    # Run agent — workflow_interceptor is sync+blocking (Gemini HTTP calls inside);
    # run in a thread pool to avoid blocking the event loop.
    import asyncio as _asyncio
    result = await _asyncio.to_thread(
        chat,
        conversation_id=body.conversation_id,
        user_id=user_id,
        user_message=body.message,
        consecutive_low_confidence=consecutive_low,
        category=effective_category,
    )

    # If the agent detected a mid-conversation category upgrade, update the DB persona
    # and ticket category so the dashboard and future messages use the specialist.
    if result.upgraded_category:
        from engine.mock_agents import pick_agent as _pick_agent
        specialist = _pick_agent(result.upgraded_category)
        assign_ai_persona(body.conversation_id, specialist["name"], specialist["avatar"], specialist["avatar_url"])
        update_ticket_category(body.conversation_id, result.upgraded_category)

    # Persist assistant reply — include confidence so server-side counter can read it
    add_message(body.conversation_id, "assistant", result.text, {
        "escalated": result.escalated,
        "escalation_reason": result.escalation_reason,
        "confidence": result.confidence,
    })

    # After the AI replies, move status to Pending_Customer (ball is in customer's court).
    # Skip if the AI escalated — agent.py already wrote the correct Escalated status.
    if not result.escalated and _ticket_id:
        update_ticket_status(_ticket_id, "pending_customer")

    # Merge intent-resolver agent update with any mid-conversation upgrade from the agent.
    # result fields take precedence (agent upgrade is more specific).
    _final_agent_name = result.agent_name or (_intent_resolved_agent["name"] if _intent_resolved_agent else None)
    _final_agent_avatar = result.agent_avatar or (_intent_resolved_agent["avatar"] if _intent_resolved_agent else None)
    _final_agent_avatar_url = result.agent_avatar_url or (_intent_resolved_agent["avatar_url"] if _intent_resolved_agent else None)
    _final_upgraded_category = result.upgraded_category or (effective_category if _intent_resolved_agent else None)

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
    )


class CSATRequest(BaseModel):
    ticket_id: str
    score: int  # 1–5


@router.post("/csat")
def submit_csat(body: CSATRequest, user_id: str = Depends(get_user_id)):
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
    user_id: str = Depends(get_user_id),
):
    if page is not None and limit is not None:
        history = get_paginated_history(conversation_id, page=page, limit=limit)
    else:
        history = get_history(conversation_id, limit=50)
    return {
        "history": history,
        "human_handling": is_human_handling(conversation_id),
    }


@router.get("/customer-tickets")
def list_customer_tickets(
    page: int = 1,
    limit: int = 10,
    user_id: str = Depends(get_user_id),
):
    tickets = get_customer_tickets(user_id, page=page, limit=limit)
    return {"tickets": tickets}


@router.get("/open-ticket")
def get_open_ticket(user_id: str = Depends(get_user_id)):
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
