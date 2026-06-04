"""CS Dashboard API routes — internal agent-facing endpoints."""
import asyncio
import logging
import time
import uuid
import shutil

logger = logging.getLogger(__name__)
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from pydantic import BaseModel
from typing import Optional

UPLOADS_DIR = Path(__file__).parent.parent.parent / "uploads" / "avatars"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
from api.middleware.auth import get_user_id
from db.conversation_store import (
    get_open_tickets, get_ticket_stats, get_ticket_with_history,
    update_ticket_status, add_message,
    get_all_conversations, get_conversation_with_history,
    transfer_ticket, snooze_ticket, block_ticket, set_pending_internal,
    get_all_tags, set_tags_for_ticket, create_tag, delete_tag,
    get_agents as db_get_agents, get_agent, create_agent as db_create_agent,
    update_agent as db_update_agent, set_agent_active, set_agent_password, set_agent_state,
    get_roles as db_get_roles, create_role as db_create_role,
    update_role as db_update_role, delete_role as db_delete_role,
)
from api.ws_manager import manager
from engine.notifications import create_notification, fan_out_to_supervisors
from engine.notification_scanner import _SLA_TARGETS, _SLA_WARNING_PCT
from engine.assignment_client import emit_ticket_event
# USERS_BY_ID is kept for legacy imports but is always empty; agent info is fetched from DB instead
# from api.routes.auth import USERS_BY_ID  # reverted if needed

router = APIRouter(prefix="/api", tags=["dashboard"])

# ---------------------------------------------------------------------------
# Mock stubs — replace with real DB queries when agents table exists
# ---------------------------------------------------------------------------

MOCK_AGENTS = [
    {"id": "agent_1", "name": "Ploy", "avatar_url": "https://i.pravatar.cc/150?img=47", "status": "available", "active_conversation_count": 1, "max_capacity": 3, "skills": ["kyc", "general"], "shift": "Morning A"},
    {"id": "agent_2", "name": "James", "avatar_url": "https://i.pravatar.cc/150?img=11", "status": "busy", "active_conversation_count": 3, "max_capacity": 3, "skills": ["finance"], "shift": "Morning B"},
    {"id": "agent_3", "name": "Mint", "avatar_url": "https://i.pravatar.cc/150?img=49", "status": "away", "active_conversation_count": 0, "max_capacity": 3, "skills": ["tech"], "shift": "Afternoon"},
    {"id": "agent_4", "name": "Arm", "avatar_url": "https://i.pravatar.cc/150?img=15", "status": "available", "active_conversation_count": 2, "max_capacity": 3, "skills": ["general", "finance"], "shift": "Morning A"},
    {"id": "agent_5", "name": "Nook", "avatar_url": "https://i.pravatar.cc/150?img=45", "status": "offline", "active_conversation_count": 0, "max_capacity": 3, "skills": ["kyc"], "shift": "Evening"},
]

MOCK_CANNED_RESPONSES = [
    {"id": "cr_1", "title": "Greeting", "shortcut": "greeting", "body": "Hello {{customer_name}}, thank you for contacting Bitazza support. How can I help you today?", "scope": "shared"},
    {"id": "cr_2", "title": "KYC Docs Required", "shortcut": "kyc-docs", "body": "To proceed with your KYC verification, please prepare: 1) National ID or Passport, 2) Selfie with ID, 3) Proof of address.", "scope": "shared"},
    {"id": "cr_3", "title": "Closing", "shortcut": "close", "body": "Thank you for contacting Bitazza support. Your ticket #{{ticket_id}} has been resolved. Please don't hesitate to reach out if you need further assistance.", "scope": "shared"},
]

MOCK_TAGS = ["kyc-pending", "withdrawal-issue", "deposit-issue", "vip-followup", "fraud-flagged", "awaiting-docs", "2fa-reset"]


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ReplyRequest(BaseModel):
    message: str
    is_internal_note: bool = False

class StatusRequest(BaseModel):
    status: str

class PriorityRequest(BaseModel):
    priority: int  # 1 (VIP) | 2 (EA) | 3 (Standard)

class AssignRequest(BaseModel):
    assigned_to: Optional[str] = None
    agent_id: Optional[str] = None  # backwards compat
    team: Optional[str] = None
    handoff_note: Optional[str] = None

class AgentStatusRequest(BaseModel):
    status: str  # available | busy | away | break | after_call_work | offline

class TagsRequest(BaseModel):
    tags: list[str]

class CannedResponseCreate(BaseModel):
    title: str
    shortcut: str
    body: str
    scope: str = "personal"

class TransferRequest(BaseModel):
    transferred_to: str  # team name: kyc | finance | compliance | fraud | ops
    note: Optional[str] = None

class SnoozeRequest(BaseModel):
    snooze_until: int  # unix timestamp

class BlockRequest(BaseModel):
    blocked_on: str  # kyc | finance | compliance | fraud | ops

class PendingInternalRequest(BaseModel):
    blocked_on: str


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@router.get("/conversations")
def list_conversations(
    view: str = "all_open",
    search: str = "",
    user_id: str = Depends(get_user_id),
):
    convs = get_all_conversations()
    if search:
        q = search.lower()
        convs = [c for c in convs if q in (c.get("last_message") or "").lower()
                 or q in (c.get("user_id") or "").lower()]
    return {"conversations": convs}


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, user_id: str = Depends(get_user_id)):
    conv = get_conversation_with_history(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.post("/conversations/{conversation_id}/reply")
async def reply_to_conversation(conversation_id: str, body: ReplyRequest, user_id: str = Depends(get_user_id)):
    conv = get_conversation_with_history(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    agent_info = get_agent(user_id)  # live DB lookup — was USERS_BY_ID.get(user_id) (always empty)
    agent_display_name = agent_info["name"] if agent_info else user_id
    agent_avatar_url = agent_info.get("avatar_url") if agent_info else None
    mid = add_message(conversation_id, "agent", body.message, {
        "agent_id": user_id,
        "agent_name": agent_display_name,
        "agent_avatar_url": agent_avatar_url,
        "is_internal_note": body.is_internal_note,
    })
    # Mark as human-handled so the AI bot stops replying
    if not body.is_internal_note:
        update_ticket_status(conversation_id, "in_progress", agent_id=user_id)
    _now = int(time.time())
    _msg_payload = {
        "id": mid,
        "role": "agent",
        "sender_type": "agent",
        "content": body.message,
        "agent_name": agent_display_name,
        "agent_avatar": agent_display_name[0].upper(),
        "agent_avatar_url": agent_avatar_url,
        "created_at": _now,
        "is_internal_note": body.is_internal_note,
        "mentions": [],
    }
    await manager.broadcast(conversation_id, {
        "type": "new_message",
        "conversation_id": conversation_id,
        "message": _msg_payload,
    }, dashboard_only=body.is_internal_note)
    # Push to Node Socket.io so dashboard agents see the message in real-time
    asyncio.create_task(emit_ticket_event(conversation_id, "new_message", {"message": _msg_payload}))
    return {"status": "sent"}


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

@router.get("/tickets")
def list_tickets(search: str = "", status_filter: str = "all", user_id: str = Depends(get_user_id)):
    return {"tickets": get_open_tickets(search=search, status_filter=status_filter)}


@router.get("/tickets/stats")
def ticket_stats(user_id: str = Depends(get_user_id)):
    return get_ticket_stats()


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


@router.post("/tickets/{ticket_id}/reply")
async def reply_to_ticket(ticket_id: str, body: ReplyRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    agent_info = get_agent(user_id)  # live DB lookup — was USERS_BY_ID.get(user_id) (always empty)
    agent_display_name = agent_info["name"] if agent_info else user_id
    agent_avatar_url = agent_info.get("avatar_url") if agent_info else None
    mid = add_message(
        conversation_id=ticket_id,
        role="agent",
        content=body.message,
        metadata={
            "agent_id": user_id,
            "agent_name": agent_display_name,
            "agent_avatar_url": agent_avatar_url,
            "is_internal_note": body.is_internal_note,
        },
    )
    if not body.is_internal_note:
        update_ticket_status(ticket_id, "in_progress", agent_id=user_id)
    _now = int(time.time())
    _msg_payload = {
        "id": mid,
        "role": "agent",
        "sender_type": "agent",
        "content": body.message,
        "agent_name": agent_display_name,
        "agent_avatar": agent_display_name[0].upper(),
        "agent_avatar_url": agent_avatar_url,
        "created_at": _now,
        "is_internal_note": body.is_internal_note,
        "mentions": [],
    }
    await manager.broadcast(ticket_id, {
        "type": "new_message",
        "conversation_id": ticket_id,
        "message": _msg_payload,
    }, dashboard_only=body.is_internal_note)
    # Push to Node Socket.io so dashboard agents see the message in real-time
    asyncio.create_task(emit_ticket_event(ticket_id, "new_message", {"message": _msg_payload}))
    return {"status": "sent"}


class MessagesRequest(BaseModel):
    content: str
    is_note: bool = False
    channel: Optional[str] = None


@router.post("/tickets/{ticket_id}/messages")
async def post_ticket_message(ticket_id: str, body: MessagesRequest, user_id: str = Depends(get_user_id)):
    """Alias used by the dashboard inbox composer (content/is_note/channel field names)."""
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    agent_info = get_agent(user_id)  # live DB lookup — was USERS_BY_ID.get(user_id) (always empty)
    logger.warning("DEBUG avatar: user_id=%r agent_info=%r", user_id, agent_info)
    agent_display_name = agent_info["name"] if agent_info else user_id
    agent_avatar_url = agent_info.get("avatar_url") if agent_info else None
    sender_type = "internal_note" if body.is_note else "agent"
    mid = add_message(
        conversation_id=ticket_id,
        role=sender_type,
        content=body.content,
        metadata={
            "agent_id": user_id,
            "agent_name": agent_display_name,
            "agent_avatar_url": agent_avatar_url,
            "is_internal_note": body.is_note,
            "channel": body.channel,
        },
    )
    if not body.is_note:
        update_ticket_status(ticket_id, "in_progress", agent_id=user_id)
    _now = int(time.time())
    _msg_payload = {
        "id": mid,
        "role": sender_type,
        "sender_type": sender_type,
        "content": body.content,
        "agent_name": agent_display_name,
        "agent_avatar": agent_display_name[0].upper(),
        "agent_avatar_url": agent_avatar_url,
        "created_at": _now,
        "is_internal_note": body.is_note,
        "mentions": [],
    }
    await manager.broadcast(ticket_id, {
        "type": "new_message",
        "conversation_id": ticket_id,
        "message": _msg_payload,
    }, dashboard_only=body.is_note)
    # Push to Node Socket.io so dashboard agents see the message in real-time
    asyncio.create_task(emit_ticket_event(ticket_id, "new_message", {"message": _msg_payload}))
    return {"ok": True, "message": _msg_payload}


@router.patch("/tickets/{ticket_id}/status")
async def update_status(ticket_id: str, body: StatusRequest, user_id: str = Depends(get_user_id)):
    # Map frontend status values to internal DB values
    STATUS_MAP = {
        "Open_Live": "unclassified",
        "In_Progress": "in_progress",
        "Pending_Customer": "pending_customer",
        "Closed_Resolved": "resolved",
        "Closed_Unresponsive": "closed",
        "Orphaned": "closed",
        "Escalated": "escalated",
    }
    internal_status = STATUS_MAP.get(body.status, body.status)
    valid = {"unclassified","in_progress","pending_human","assigned","pending_customer","pending_internal","transferred","snoozed","blocked","resolved","closed","spam","escalated"}
    if internal_status not in valid:
        raise HTTPException(status_code=400, detail=f"status must be one of {valid}")
    update_ticket_status(ticket_id, internal_status, agent_id=user_id)
    await manager.broadcast(ticket_id, {
        "type": "status_change",
        "conversation_id": ticket_id,
        "status": body.status,
    })
    # Notify supervisors when a ticket is escalated
    if body.status == "Escalated":
        for notif in fan_out_to_supervisors(
            type="escalated",
            priority="high",
            title=f"Ticket #{ticket_id[:8]} escalated",
            body=f"Escalated by agent {user_id}",
            ticket_id=ticket_id,
        ):
            await manager.broadcast_all({"type": "notification:new", "notification": notif})
    return {"status": body.status}


@router.patch("/tickets/{ticket_id}/priority")
def update_priority(ticket_id: str, body: PriorityRequest, user_id: str = Depends(get_user_id)):
    valid = {1, 2, 3}
    if body.priority not in valid:
        raise HTTPException(status_code=400, detail=f"priority must be 1 (VIP), 2 (EA), or 3 (Standard)")
    # Stub — add priority column to tickets table when ready
    return {"priority": body.priority}


@router.patch("/tickets/{ticket_id}/assign")
async def assign_ticket(ticket_id: str, body: AssignRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    target_agent = body.assigned_to or body.agent_id
    update_ticket_status(ticket_id, "assigned", agent_id=target_agent)
    if body.handoff_note:
        add_message(ticket_id, "system", f"[Handoff] {body.handoff_note}", {"agent_id": user_id})
    await manager.broadcast(ticket_id, {
        "type": "ticket_assigned",
        "conversation_id": ticket_id,
        "agent_id": target_agent,
        "agent_name": next((a["name"] for a in MOCK_AGENTS if a["id"] == target_agent), target_agent),
    })
    # Notify the assigned agent
    if target_agent:
        customer_name = ticket.get("customer_name") or ticket.get("customer", {}).get("name") if isinstance(ticket, dict) else None
        notif = create_notification(
            user_id=target_agent,
            role="agent",
            type="assigned",
            priority="medium",
            title=f"Ticket #{ticket_id[:8]} assigned to you",
            body=f"From {customer_name or 'a customer'} — {ticket.get('channel', 'web')} channel",
            ticket_id=ticket_id,
        )
        await manager.broadcast_all({"type": "notification:new", "notification": notif})
    return {"status": "assigned", "agent_id": target_agent}


@router.patch("/tickets/{ticket_id}/tags")
def update_tags(ticket_id: str, body: TagsRequest, user_id: str = Depends(get_user_id)):
    set_tags_for_ticket(ticket_id, body.tags)
    return {"tags": body.tags}


@router.post("/tickets/{ticket_id}/escalate")
async def escalate_ticket(ticket_id: str, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    update_ticket_status(ticket_id, "escalated", agent_id=user_id)
    await manager.broadcast(ticket_id, {
        "type": "status_change",
        "conversation_id": ticket_id,
        "status": "Escalated",
    })
    customer_name = ticket.get("customer_name") or (ticket.get("customer") or {}).get("name") if isinstance(ticket, dict) else None
    for notif in fan_out_to_supervisors(
        type="escalated",
        priority="high",
        title=f"Ticket #{ticket_id[:8]} escalated",
        body=f"{customer_name or 'A customer'} — escalated by agent",
        ticket_id=ticket_id,
    ):
        await manager.broadcast_all({"type": "notification:new", "notification": notif})
    return {"status": "escalated"}


@router.post("/tickets/{ticket_id}/transfer")
async def transfer_ticket_endpoint(ticket_id: str, body: TransferRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    transfer_ticket(ticket_id, body.transferred_to, user_id)
    if body.note:
        add_message(ticket_id, "system", f"[Transfer → {body.transferred_to}] {body.note}", {"agent_id": user_id})
    await manager.broadcast(ticket_id, {"type": "status_change", "conversation_id": ticket_id, "status": "transferred", "transferred_to": body.transferred_to})
    return {"status": "transferred", "transferred_to": body.transferred_to}


@router.post("/tickets/{ticket_id}/snooze")
async def snooze_ticket_endpoint(ticket_id: str, body: SnoozeRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    snooze_ticket(ticket_id, body.snooze_until, user_id)
    await manager.broadcast(ticket_id, {"type": "status_change", "conversation_id": ticket_id, "status": "snoozed", "snooze_until": body.snooze_until})
    return {"status": "snoozed", "snooze_until": body.snooze_until}


@router.post("/tickets/{ticket_id}/block")
async def block_ticket_endpoint(ticket_id: str, body: BlockRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    block_ticket(ticket_id, body.blocked_on, user_id)
    await manager.broadcast(ticket_id, {"type": "status_change", "conversation_id": ticket_id, "status": "blocked", "blocked_on": body.blocked_on})
    return {"status": "blocked", "blocked_on": body.blocked_on}


@router.post("/tickets/{ticket_id}/pending-internal")
async def pending_internal_endpoint(ticket_id: str, body: PendingInternalRequest, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    set_pending_internal(ticket_id, body.blocked_on, user_id)
    await manager.broadcast(ticket_id, {"type": "status_change", "conversation_id": ticket_id, "status": "pending_internal", "blocked_on": body.blocked_on})
    return {"status": "pending_internal", "blocked_on": body.blocked_on}


@router.post("/tickets/{ticket_id}/resolve-request")
async def resolve_request_endpoint(ticket_id: str, user_id: str = Depends(get_user_id)):
    ticket = get_ticket_with_history(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    add_message(ticket_id, "system", "__resolve_request__", {"agent_id": user_id})
    update_ticket_status(ticket_id, "resolved", agent_id=user_id)
    await manager.broadcast(ticket_id, {
        "type": "ticket:resolve_request",
        "conversation_id": ticket_id,
    })
    return {"status": "resolve_request_sent"}


# ---------------------------------------------------------------------------
# Bulk actions
# ---------------------------------------------------------------------------

class BulkActionRequest(BaseModel):
    ticket_ids: list[str]
    action: str          # assign | close | tag | set_priority | set_status
    value: Optional[str] = None
    tags: Optional[list[str]] = None

@router.post("/tickets/bulk")
async def bulk_action(body: BulkActionRequest, user_id: str = Depends(get_user_id)):
    results = []
    for tid in body.ticket_ids:
        if body.action == "close":
            update_ticket_status(tid, "closed", agent_id=user_id)
            results.append({"id": tid, "result": "closed"})
            await manager.broadcast(tid, {"type": "status_change", "conversation_id": tid, "status": "Closed_Resolved"})
        elif body.action == "assign" and body.value:
            update_ticket_status(tid, "assigned", agent_id=body.value)
            results.append({"id": tid, "result": "assigned"})
            await manager.broadcast(tid, {"type": "ticket_assigned", "conversation_id": tid, "agent_id": body.value})
        elif body.action == "set_status" and body.value:
            update_ticket_status(tid, body.value, agent_id=user_id)
            results.append({"id": tid, "result": body.value})
            await manager.broadcast(tid, {"type": "status_change", "conversation_id": tid, "status": body.value})
        else:
            results.append({"id": tid, "result": "skipped"})
    return {"results": results}


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

@router.get("/agents")
def get_agents_list(include_inactive: bool = False, user_id: str = Depends(get_user_id)):
    return db_get_agents(include_inactive=include_inactive)

@router.post("/agents")
def create_agent_route(data: dict, user_id: str = Depends(get_user_id)):
    import bcrypt
    password = data.get("password", "")
    if not password:
        raise HTTPException(status_code=400, detail="password required")
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    agent = db_create_agent(
        name=data["name"], email=data["email"], password_hash=pw_hash,
        role=data.get("role", "agent"), team=data.get("team", "cs"),
        max_chats=data.get("max_chats", 3), skills=data.get("skills", []),
        shift=data.get("shift"),
    )
    return agent

@router.patch("/agents/me/status")
def set_my_status(body: AgentStatusRequest, user_id: str = Depends(get_user_id)):
    valid = {"Available", "Busy", "Break", "Offline"}
    state = body.status.capitalize() if body.status.lower() in {v.lower() for v in valid} else None
    if not state:
        raise HTTPException(status_code=400, detail=f"status must be one of {valid}")
    set_agent_state(user_id, state)
    return {"status": state}

@router.patch("/agents/{agent_id}")
def update_agent_route(agent_id: str, data: dict, user_id: str = Depends(get_user_id)):
    agent = db_update_agent(agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent

@router.delete("/agents/{agent_id}")
def deactivate_agent(agent_id: str, user_id: str = Depends(get_user_id)):
    set_agent_active(agent_id, False)
    return {"status": "deactivated"}

@router.post("/agents/{agent_id}/reactivate")
def reactivate_agent(agent_id: str, user_id: str = Depends(get_user_id)):
    set_agent_active(agent_id, True)
    return {"status": "reactivated"}

@router.post("/agents/{agent_id}/reset-password")
def reset_agent_password(agent_id: str, data: dict, user_id: str = Depends(get_user_id)):
    import bcrypt
    password = data.get("password", "")
    if not password:
        raise HTTPException(status_code=400, detail="password required")
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    set_agent_password(agent_id, pw_hash)
    return {"status": "password updated"}

@router.post("/agents/{agent_id}/avatar")
async def upload_agent_avatar(agent_id: str, avatar: UploadFile = File(...), user_id: str = Depends(get_user_id)):
    allowed = {"image/jpeg", "image/png", "image/gif", "image/webp"}
    if avatar.content_type not in allowed:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, GIF, or WebP images are allowed")
    ext = Path(avatar.filename or "avatar.png").suffix or ".png"
    filename = f"{agent_id}_{int(time.time() * 1000)}{ext}"
    dest = UPLOADS_DIR / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(avatar.file, f)
    avatar_url = f"/uploads/avatars/{filename}"
    agent = db_update_agent(agent_id, {"avatar_url": avatar_url})
    if not agent:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"avatar_url": avatar_url}

@router.get("/agents/availability")
def get_agents_availability(user_id: str = Depends(get_user_id)):
    return {"agents": db_get_agents()}


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

ALL_PERMISSIONS = [
    # Pages
    "section.home", "section.inbox", "section.supervisor", "section.analytics",
    "section.metrics", "section.admin", "section.studio", "section.knowledge",
    # Inbox / conversations
    "inbox.reply", "inbox.assign", "inbox.close", "inbox.claim",
    "inbox.escalate", "inbox.internal_note",
    "inbox.set_priority", "inbox.set_tags",
    # Supervision
    "supervisor.whisper", "supervisor.reassign",
    # Bot Studio
    "studio.create", "studio.edit", "studio.delete", "studio.test", "studio.publish",
    # Admin sub-sections
    "admin.agents", "admin.roles",
    "admin.tags", "admin.canned_responses", "admin.assignment_rules",
    "admin.sla_targets", "admin.bot_config", "admin.report_settings",
    # Knowledge base
    "knowledge.read", "knowledge.write",
]

@router.get("/roles")
def get_roles(user_id: str = Depends(get_user_id)):
    return {"roles": db_get_roles(), "all_permissions": ALL_PERMISSIONS}

@router.post("/roles")
def create_role(data: dict, user_id: str = Depends(get_user_id)):
    return db_create_role(name=data["name"], display_name=data.get("display_name", ""), permissions=data.get("permissions", []))

@router.patch("/roles/{name}")
def update_role(name: str, data: dict, user_id: str = Depends(get_user_id)):
    role = db_update_role(name, data)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    return role

@router.delete("/roles/{name}")
def delete_role(name: str, user_id: str = Depends(get_user_id)):
    db_delete_role(name)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Supervisor live dashboard
# ---------------------------------------------------------------------------

@router.get("/supervisor/live")
def supervisor_live(user_id: str = Depends(get_user_id)):
    tickets = get_open_tickets()
    now = int(time.time())

    # Compute SLA at-risk tickets (>= 80% of target elapsed, not yet breached)
    # Notifications for these are fired by the background scanner, not here.
    sla_at_risk = []
    for t in tickets:
        priority = t.get("priority") or 3
        target = _SLA_TARGETS.get(priority, _SLA_TARGETS[3])
        created_at = t.get("created_at")
        if not created_at:
            continue
        elapsed = now - created_at
        pct = elapsed / target
        if _SLA_WARNING_PCT <= pct < 1.0:
            sla_at_risk.append({
                "ticket_id": t["id"],
                "priority": priority,
                "elapsed_seconds": int(elapsed),
                "target_seconds": target,
                "pct": round(pct, 3),
                "customer": t.get("customer"),
            })

    return {
        "agents": db_get_agents(),
        "queue": [
            {"channel": "web", "priority": "high", "count": len([t for t in tickets if t.get("status") not in ("resolved", "closed", "spam")])},
        ],
        "sla_at_risk": sla_at_risk,
        "stats": {
            "opened_today": len(tickets),
            "resolved_today": 0,
            "avg_first_response_seconds": 0,
            "avg_resolution_seconds": 0,
            "csat_avg": None,
            "bot_active_count": 0,
            "bot_handoff_rate": 0.0,
        },
    }


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@router.get("/analytics")
def analytics(
    date_range: str = "7d",
    channel: Optional[str] = None,
    agent_id: Optional[str] = None,
    category: Optional[str] = None,
    user_id: str = Depends(get_user_id),
):
    from db.conversation_store import _conn
    days = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}.get(date_range, 7)
    with _conn() as conn:
        cur = conn.cursor()
        filters = []
        params: list = [days]
        if channel:   filters.append("AND t.channel = %s"); params.append(channel)
        if agent_id:  filters.append("AND t.assigned_to = %s::uuid"); params.append(agent_id)
        if category:  filters.append("AND t.category = %s"); params.append(category)
        f = " ".join(filters)

        cur.execute(f"""
            SELECT COUNT(*) as total,
                   COUNT(*) FILTER (WHERE t.status IN ('Closed_Resolved','Closed_Unresolved')) as resolved
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        totals = cur.fetchone()

        cur.execute(f"""
            SELECT t.channel, COUNT(*) as count
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY t.channel ORDER BY count DESC
        """, params)
        by_channel = [{"channel": r["channel"], "count": r["count"]} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(t.created_at) as date, COUNT(*) as count
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        by_day = [{"date": str(r["date"]), "count": r["count"]} for r in cur.fetchall()]

        # First response time (time from ticket creation to first agent/bot reply)
        cur.execute(f"""
            SELECT AVG(EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as avg_frt,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as median_frt,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as p90_frt
            FROM tickets t
            JOIN LATERAL (
                SELECT created_at FROM messages
                WHERE ticket_id = t.id AND sender_type IN ('agent','bot')
                ORDER BY created_at LIMIT 1
            ) m ON true
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        frt = cur.fetchone()

        cur.execute(f"""
            SELECT DATE(t.created_at) as date,
                   AVG(EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as avg_s
            FROM tickets t
            JOIN LATERAL (
                SELECT created_at FROM messages
                WHERE ticket_id = t.id AND sender_type IN ('agent','bot')
                ORDER BY created_at LIMIT 1
            ) m ON true
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        frt_by_day = [{"date": str(r["date"]), "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        # Resolution time
        cur.execute(f"""
            SELECT t.channel,
                   AVG(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))) as avg_s
            FROM tickets t
            WHERE t.status IN ('Closed_Resolved','Closed_Unresolved')
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY t.channel
        """, params)
        res_by_channel = [{"channel": r["channel"], "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        # Bot vs human
        cur.execute(f"""
            SELECT
                COUNT(*) FILTER (WHERE t.category = 'ai_handling') as bot_count,
                COUNT(*) as total_count
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        bot_row = cur.fetchone()
        total_c = bot_row["total_count"] or 1
        bot_c = bot_row["bot_count"] or 0

        cur.execute(f"""
            SELECT DATE(t.created_at) as date,
                   COUNT(*) FILTER (WHERE t.category = 'ai_handling') as bot,
                   COUNT(*) FILTER (WHERE t.category != 'ai_handling') as human
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        bot_by_day = [{"date": str(r["date"]), "bot": r["bot"], "human": r["human"]} for r in cur.fetchall()]

        # CSAT
        cur.execute(f"""
            SELECT AVG(t.csat_score) as avg,
                   COUNT(t.csat_score) as count
            FROM tickets t
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        csat_row = cur.fetchone()

        cur.execute(f"""
            SELECT u.name, AVG(t.csat_score) as avg, COUNT(t.csat_score) as count
            FROM tickets t JOIN users u ON t.assigned_to = u.id
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY u.name ORDER BY avg DESC
        """, params)
        csat_by_agent = [{"name": r["name"], "avg": round(float(r["avg"]), 2), "count": r["count"]} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(t.created_at) as date, AVG(t.csat_score) as avg
            FROM tickets t
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        csat_trend = [{"date": str(r["date"]), "avg": round(float(r["avg"]), 2)} for r in cur.fetchall()]

    return {
        "volume": {
            "total": totals["total"],
            "resolved": totals["resolved"],
            "by_channel": by_channel,
            "by_day": by_day,
        },
        "response_time": {
            "avg": round(float(frt["avg_frt"] or 0)),
            "median": round(float(frt["median_frt"] or 0)),
            "p90": round(float(frt["p90_frt"] or 0)),
            "by_day": frt_by_day,
        },
        "resolution": {
            "by_channel": res_by_channel,
        },
        "bot_performance": {
            "resolution_rate": round(bot_c / total_c, 3),
            "handoff_rate": round(1 - bot_c / total_c, 3),
            "by_day": bot_by_day,
        },
        "csat": {
            "avg": round(float(csat_row["avg"]), 2) if csat_row["avg"] else None,
            "count": csat_row["count"],
            "by_agent": csat_by_agent,
            "trend": csat_trend,
        },
    }


@router.get("/metrics")
def metrics(
    range: str = "7d",
    channel: Optional[str] = None,
    agent_id: Optional[str] = None,
    user_id: str = Depends(get_user_id),
):
    from db.conversation_store import _conn
    days = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}.get(range, 7)
    with _conn() as conn:
        cur = conn.cursor()
        filters = []
        params: list = [days]
        if channel:  filters.append("AND t.channel = %s"); params.append(channel)
        if agent_id: filters.append("AND t.assigned_to = %s::uuid"); params.append(agent_id)
        f = " ".join(filters)

        # FRT avg + by agent + over time
        cur.execute(f"""
            SELECT AVG(EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as avg_s
            FROM tickets t
            JOIN LATERAL (
                SELECT created_at FROM messages
                WHERE ticket_id = t.id AND sender_type IN ('agent','bot')
                ORDER BY created_at LIMIT 1
            ) m ON true
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        frt_avg = cur.fetchone()["avg_s"] or 0

        cur.execute(f"""
            SELECT u.name,
                   AVG(EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as avg_s
            FROM tickets t
            JOIN users u ON t.assigned_to = u.id
            JOIN LATERAL (
                SELECT created_at FROM messages
                WHERE ticket_id = t.id AND sender_type = 'agent'
                ORDER BY created_at LIMIT 1
            ) m ON true
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY u.name ORDER BY avg_s
        """, params)
        frt_by_agent = [{"name": r["name"], "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(t.created_at) as date,
                   AVG(EXTRACT(EPOCH FROM (m.created_at - t.created_at))) as avg_s
            FROM tickets t
            JOIN LATERAL (
                SELECT created_at FROM messages
                WHERE ticket_id = t.id AND sender_type IN ('agent','bot')
                ORDER BY created_at LIMIT 1
            ) m ON true
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        frt_over_time = [{"date": str(r["date"]), "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        # AHT (avg handle time = resolution time for closed tickets)
        cur.execute(f"""
            SELECT AVG(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))) as avg_s
            FROM tickets t
            WHERE t.status IN ('Closed_Resolved','Closed_Unresolved')
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        aht_avg = cur.fetchone()["avg_s"] or 0

        cur.execute(f"""
            SELECT t.channel,
                   AVG(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))) as avg_s
            FROM tickets t
            WHERE t.status IN ('Closed_Resolved','Closed_Unresolved')
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY t.channel
        """, params)
        aht_by_channel = [{"channel": r["channel"], "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(t.created_at) as date,
                   AVG(EXTRACT(EPOCH FROM (t.updated_at - t.created_at))) as avg_s
            FROM tickets t
            WHERE t.status IN ('Closed_Resolved','Closed_Unresolved')
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY DATE(t.created_at) ORDER BY date
        """, params)
        aht_over_time = [{"date": str(r["date"]), "avg_s": round(r["avg_s"] or 0)} for r in cur.fetchall()]

        # CSAT
        cur.execute(f"""
            SELECT AVG(t.csat_score) as avg, COUNT(t.csat_score) as count
            FROM tickets t
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        csat_row = cur.fetchone()

        cur.execute(f"""
            SELECT t.csat_score as score, COUNT(*) as count
            FROM tickets t
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY t.csat_score ORDER BY t.csat_score
        """, params)
        csat_dist = [{"score": r["score"], "count": r["count"]} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT u.name, AVG(t.csat_score) as avg, COUNT(t.csat_score) as count
            FROM tickets t JOIN users u ON t.assigned_to = u.id
            WHERE t.csat_score IS NOT NULL
              AND t.created_at >= NOW() - (%s || ' days')::interval {f}
            GROUP BY u.name ORDER BY avg DESC
        """, params)
        csat_by_agent = [{"name": r["name"], "avg": round(float(r["avg"]), 2), "count": r["count"]} for r in cur.fetchall()]

        # Summary
        cur.execute(f"""
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status IN ('Closed_Resolved','Closed_Unresolved')) as resolved,
                COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
                COUNT(*) FILTER (WHERE sla_breached = true) as sla_breached
            FROM tickets t
            WHERE t.created_at >= NOW() - (%s || ' days')::interval {f}
        """, params)
        summary = cur.fetchone()
        total = summary["total"] or 1

    return {
        "frt": {
            "avg_s": round(float(frt_avg)),
            "by_agent": frt_by_agent,
            "over_time": frt_over_time,
        },
        "aht": {
            "avg_s": round(float(aht_avg)),
            "by_channel": aht_by_channel,
            "over_time": aht_over_time,
        },
        "csat": {
            "avg": round(float(csat_row["avg"]), 2) if csat_row["avg"] else None,
            "count": csat_row["count"],
            "distribution": csat_dist,
            "by_agent": csat_by_agent,
        },
        "summary": {
            "total_tickets": summary["total"],
            "resolved": summary["resolved"],
            "escalated": summary["escalated"],
            "sla_breached": summary["sla_breached"],
            "resolution_rate": round(summary["resolved"] / total, 3),
        },
    }


# ---------------------------------------------------------------------------
# Canned responses
# ---------------------------------------------------------------------------

@router.get("/canned-responses")
def list_canned_responses(user_id: str = Depends(get_user_id)):
    return MOCK_CANNED_RESPONSES


@router.post("/canned-responses")
def create_canned_response(body: CannedResponseCreate, user_id: str = Depends(get_user_id)):
    import uuid
    new = {"id": str(uuid.uuid4()), **body.dict()}
    MOCK_CANNED_RESPONSES.append(new)
    return new


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

@router.get("/tags")
def list_tags(user_id: str = Depends(get_user_id)):
    return {"tags": get_all_tags()}


class CreateTagRequest(BaseModel):
    name: str

@router.post("/tags")
def add_tag(body: CreateTagRequest, user_id: str = Depends(get_user_id)):
    name = body.name.strip().lower().replace(" ", "_")
    if not name:
        raise HTTPException(status_code=400, detail="Tag name required")
    create_tag(name)
    return {"tags": get_all_tags()}

@router.delete("/tags/{name}")
def remove_tag(name: str, user_id: str = Depends(get_user_id)):
    delete_tag(name)
    return {"tags": get_all_tags()}


# ---------------------------------------------------------------------------
# Whisper (supervisor coaching messages)
# ---------------------------------------------------------------------------

class WhisperRequest(BaseModel):
    ticket_id: str
    content: str
    target_agent_id: str

@router.post("/supervisor/whisper")
async def send_whisper(body: WhisperRequest, user_id: str = Depends(get_user_id)):
    """Supervisor sends a coaching whisper to the agent handling a ticket."""
    agent_info = get_agent(user_id)
    supervisor_name = agent_info["name"] if agent_info else user_id
    await manager.broadcast(body.ticket_id, {
        "type": "whisper",
        "ticket_id": body.ticket_id,
        "content": body.content,
        "supervisor_name": supervisor_name,
    })
    notif = create_notification(
        user_id=body.target_agent_id,
        role="agent",
        type="whisper",
        priority="info",
        title=f"Coaching note from {supervisor_name}",
        body=body.content[:120],
        ticket_id=body.ticket_id,
    )
    await manager.broadcast_all({"type": "notification:new", "notification": notif})
    return {"status": "sent"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@router.websocket("/ws/conversations")
async def ws_conversations(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event_type = data.get("type")
            conv_id = data.get("conversation_id")
            if event_type == "presence" and conv_id:
                await manager.broadcast(conv_id, {
                    "type": "agent_presence",
                    "conversation_id": conv_id,
                    "agent_id": data.get("agent_id", ""),
                    "agent_name": data.get("agent_name", ""),
                    "action": data.get("action", "join"),
                })
            elif event_type == "typing" and conv_id:
                await manager.broadcast(conv_id, {
                    "type": "agent_typing",
                    "conversation_id": conv_id,
                    "agent_id": data.get("agent_id", ""),
                    "agent_name": data.get("agent_name", ""),
                })
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Notification channel configs
# ---------------------------------------------------------------------------

VALID_CHANNELS = {"slack", "teams", "discord", "line", "email", "notion", "confluence"}


class NotificationChannelUpsert(BaseModel):
    enabled: bool
    config: dict
    reports: dict  # {"daily": bool, "weekly": bool}
    report_type: str = "daily"  # for test endpoint only


@router.get("/admin/notification-channels")
def list_notification_channels(user_id: str = Depends(get_user_id)):
    from engine.report_sender import get_all_notification_channels
    rows = get_all_notification_channels()
    # Return all 7 channels, filling in defaults for unconfigured ones
    result = {}
    for ch in VALID_CHANNELS:
        result[ch] = {"channel": ch, "enabled": False, "config": {}, "reports": {"daily": True, "weekly": True}}
    for row in rows:
        result[row["channel"]] = {
            "channel":  row["channel"],
            "enabled":  row["enabled"],
            "config":   row["config"],
            "reports":  row["reports"],
            "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }
    return list(result.values())


@router.put("/admin/notification-channels/{channel}")
def save_notification_channel(
    channel: str,
    body: NotificationChannelUpsert,
    user_id: str = Depends(get_user_id),
):
    if channel not in VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}")
    from engine.report_sender import upsert_notification_channel
    row = upsert_notification_channel(channel, body.enabled, body.config, body.reports, user_id)
    return {
        "channel":  row["channel"],
        "enabled":  row["enabled"],
        "config":   row["config"],
        "reports":  row["reports"],
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
    }


@router.post("/admin/notification-channels/{channel}/test")
async def test_notification_channel(
    channel: str,
    body: NotificationChannelUpsert,
):
    if channel not in VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}")
    try:
        from engine.report_sender import send_test_report
        report_type = body.report_type if body.report_type in ("daily", "weekly") else "daily"
        await send_test_report(channel, body.config, report_type)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
