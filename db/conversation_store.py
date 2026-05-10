"""
Conversation and ticket state storage — PostgreSQL (shared with dashboard).

All widget conversations are written directly into the dashboard's PostgreSQL
schema (customers / tickets / messages tables), so the Node dashboard sees them
without any sync layer.

Requires: psycopg2-binary  (add to requirements.txt)
Env var:  DATABASE_URL  — same connection string used by the Node dashboard.
"""
import json, logging, time, uuid
from contextlib import contextmanager

import psycopg2

logger = logging.getLogger(__name__)
import psycopg2.extras
from config import settings

DATABASE_URL = settings.DATABASE_URL


@contextmanager
def _conn():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield conn
        conn.commit()
    except Exception:
        logger.exception("DB transaction failed — rolling back")
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """No-op — schema is managed by the Node dashboard's migrate.js."""
    pass


# ── Category → team routing map ──────────────────────────────────────────────
# Must stay in sync with CATEGORY_TEAM_MAP in dashboard/server/src/routes/tickets.js

_CATEGORY_TEAM: dict[str, str] = {
    "kyc_verification":    "kyc",
    "withdrawal_issue":    "withdrawals",
    "account_restriction": "cs",
    "password_2fa_reset":  "cs",
    "fraud_security":      "cs",
}

# ── Helpers ──────────────────────────────────────────────────────────────────

def _role_to_sender_type(role: str) -> str:
    """Map widget roles to dashboard sender_type values."""
    return {
        "user": "customer",
        "assistant": "bot",
        "agent": "agent",
        "system": "system",
    }.get(role, role)


def _sender_type_to_role(sender_type: str) -> str:
    return {
        "customer": "user",
        "bot": "assistant",
        "agent": "agent",
        "system": "system",
        "internal_note": "agent",
        "whisper": "agent",
    }.get(sender_type, sender_type)


# ── Conversations / Customers ─────────────────────────────────────────────────

def _fetch_user_profile(user_id: str, _retries: int = 3, _delay: float = 0.2) -> dict:
    """
    Fetch user profile from the User/KYC API (mock or real).
    Retries up to _retries times on transient failures before giving up.
    Returns an empty dict only if all attempts fail.
    """
    import requests as _requests
    use_mock = settings.USE_MOCK_USER_API
    base = settings.USER_API_BASE_URL
    key  = settings.USER_API_KEY
    prefix = "/mock" if use_mock else ""
    url = f"{base}{prefix}/user"
    for attempt in range(1, _retries + 1):
        try:
            r = _requests.get(
                url,
                params={"user_id": user_id},
                headers={"Authorization": f"Bearer {key}"},
                timeout=3,
            )
            if r.status_code == 200:
                return r.json()
        except Exception:
            logger.warning(
                "Profile fetch attempt %d/%d failed for user_id=%s",
                attempt, _retries, user_id,
            )
            if attempt < _retries:
                time.sleep(_delay)
    logger.error("All %d profile fetch attempts failed for user_id=%s — continuing without profile", _retries, user_id)
    return {}


def _ensure_customer(cur, user_id: str) -> str:
    """
    Look up a customer by their widget user_id.
    Creates one if it doesn't exist, enriching with real profile data from the
    User/KYC API so the dashboard shows name, email, tier, and KYC status.
    Returns the customer UUID.
    """
    cur.execute("SELECT id, name FROM customers WHERE external_id = %s", (user_id,))
    row = cur.fetchone()
    if row:
        # Always refresh kyc_status on every new ticket so stale/missing values are fixed.
        # Also backfill name/email/tier if the row was created before the profile fetch succeeded.
        try:
            profile = _fetch_user_profile(user_id)
            first = profile.get("first_name", "")
            last  = profile.get("last_name", "")
            display_name = f"{first} {last}".strip()
            email      = profile.get("email") or None
            phone      = profile.get("phone") or None
            tier       = profile.get("tier") or None
            kyc_status = (profile.get("kyc") or {}).get("status") or None
            if display_name or kyc_status:
                cur.execute("""
                    UPDATE customers
                    SET name       = COALESCE(NULLIF(%s,''), name),
                        email      = COALESCE(%s, email),
                        phone      = COALESCE(%s, phone),
                        tier       = COALESCE(%s, tier),
                        kyc_status = COALESCE(%s, kyc_status)
                    WHERE id = %s
                """, (display_name, email, phone, tier, kyc_status, row["id"]))
        except Exception:
            logger.exception("Failed to refresh profile for user_id=%s — continuing with cached data", user_id)
        return row["id"]

    # Fall back to name-tag lookup for rows created before external_id column existed
    tag = f"widget:{user_id}"
    cur.execute("SELECT id FROM customers WHERE name = %s", (tag,))
    row = cur.fetchone()
    if row:
        # Backfill external_id + profile fields on legacy rows
        try:
            profile = _fetch_user_profile(user_id)
            first = profile.get("first_name", "")
            last  = profile.get("last_name", "")
            display_name = f"{first} {last}".strip()
            email      = profile.get("email") or None
            phone      = profile.get("phone") or None
            tier       = profile.get("tier") or None
            kyc_status = (profile.get("kyc") or {}).get("status") or None
            cur.execute("""
                UPDATE customers
                SET external_id = %s,
                    name        = COALESCE(NULLIF(%s,''), name),
                    email       = COALESCE(%s, email),
                    phone       = COALESCE(%s, phone),
                    tier        = COALESCE(%s, tier),
                    kyc_status  = COALESCE(%s, kyc_status)
                WHERE id = %s
            """, (user_id, display_name, email, phone, tier, kyc_status, row["id"]))
        except Exception:
            logger.exception("Failed to backfill profile for legacy customer user_id=%s — skipping enrichment", user_id)
        return row["id"]

    # New customer — fetch profile to populate real data
    profile = _fetch_user_profile(user_id)
    customer_id = str(uuid.uuid4())

    first = profile.get("first_name", "")
    last  = profile.get("last_name", "")
    display_name = f"{first} {last}".strip() or user_id
    email        = profile.get("email") or None
    phone        = profile.get("phone") or None
    tier         = profile.get("tier") or "regular"
    kyc_status   = (profile.get("kyc") or {}).get("status") or None

    cur.execute("""
        INSERT INTO customers (id, name, email, phone, tier, kyc_status, external_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (customer_id, display_name, email, phone, tier, kyc_status, user_id))
    return customer_id


def update_customer_from_profile(user_id: str, profile: dict) -> None:
    """
    Backfill customer name/email/tier/kyc_status from a profile dict already
    fetched by the agent's get_user_profile tool.

    Called by the agent after a successful get_user_profile tool call so that
    even if _fetch_user_profile failed at conversation creation time, the
    customer record is corrected as soon as the agent has the data.

    No-op if profile is empty or user_id has no customer row.
    """
    if not profile or "error" in profile:
        return

    first = profile.get("first_name", "")
    last  = profile.get("last_name", "")
    display_name = f"{first} {last}".strip()
    email      = profile.get("email") or None
    phone      = profile.get("phone") or None
    tier       = profile.get("tier") or None
    kyc_status = (profile.get("kyc") or {}).get("status") or None

    if not display_name:
        return

    try:
        with _conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE customers
                SET name       = COALESCE(NULLIF(%s,''), name),
                    email      = COALESCE(%s, email),
                    phone      = COALESCE(%s, phone),
                    tier       = COALESCE(%s, tier),
                    kyc_status = COALESCE(%s, kyc_status)
                WHERE external_id = %s
            """, (display_name, email, phone, tier, kyc_status, user_id))
    except Exception:
        logger.exception("update_customer_from_profile failed for user_id=%s — non-fatal", user_id)


_TIER_PRIORITY: dict[str, int] = {
    "vip": 1,
    "high_net_worth": 2,
    "ea": 2,
    "regular": 3,
}

# SLA minutes per priority (must match sla_minutes config in assignment_rules table)
_SLA_MINUTES: dict[int, int] = {1: 1, 2: 3, 3: 10}


def _priority_for_customer(cur, customer_id: str) -> int:
    """Return ticket priority (1/2/3) based on the customer's tier."""
    cur.execute("SELECT tier FROM customers WHERE id = %s", (customer_id,))
    row = cur.fetchone()
    tier = (row["tier"] or "regular").lower() if row else "regular"
    return _TIER_PRIORITY.get(tier, 3)


def create_conversation(user_id: str, platform: str, language: str = "en", issue_category: str | None = None) -> str:
    """
    Creates (or reuses) a customer row and opens a new ticket.
    Returns the ticket ID, which is used as the conversation_id throughout
    the Python layer so everything maps 1-to-1 with dashboard tickets.
    """
    with _conn() as conn:
        cur = conn.cursor()
        customer_id = _ensure_customer(cur, user_id)

        ticket_id = str(uuid.uuid4())
        team = _CATEGORY_TEAM.get(issue_category, "cs")
        priority = _priority_for_customer(cur, customer_id)
        sla_mins = _SLA_MINUTES.get(priority, 10)
        cur.execute("""
            INSERT INTO tickets (id, customer_id, channel, status, category, priority, team, sla_deadline)
            VALUES (%s, %s, 'web', 'Open_Live', %s, %s, %s, NOW() + %s * INTERVAL '1 minute')
        """, (ticket_id, customer_id, issue_category or 'unclassified', priority, team, sla_mins))

    return ticket_id  # ticket_id IS the conversation_id in the Python layer


def get_customer_id_for_user(user_id: str) -> str | None:
    """Return the persistent customer UUID for a given widget user_id, or None if not found."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM customers WHERE external_id = %s", (user_id,))
        row = cur.fetchone()
    return row["id"] if row else None


def get_customer_tickets(user_id: str, page: int = 1, limit: int = 10) -> list[dict]:
    """
    Return a paginated list of tickets for the given widget user_id, newest first.
    Each entry includes: id, category, status, created_at (unix ts),
    last_message (truncated to 100 chars), last_message_at (unix ts | None).
    """
    offset = (page - 1) * limit
    with _conn() as conn:
        cur = conn.cursor()
        # Resolve user_id → customer_id
        cur.execute("SELECT id FROM customers WHERE external_id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            return []
        customer_id = row["id"]

        cur.execute("""
            SELECT t.id, t.category, t.status, t.created_at,
                   (SELECT content FROM messages
                    WHERE ticket_id = t.id AND sender_type != 'internal_note'
                    ORDER BY created_at DESC LIMIT 1) AS last_message,
                   (SELECT created_at FROM messages
                    WHERE ticket_id = t.id AND sender_type != 'internal_note'
                    ORDER BY created_at DESC LIMIT 1) AS last_message_at
            FROM tickets t
            WHERE t.customer_id = %s
            ORDER BY COALESCE(
                (SELECT created_at FROM messages
                 WHERE ticket_id = t.id AND sender_type != 'internal_note'
                 ORDER BY created_at DESC LIMIT 1),
                t.created_at
            ) DESC
            LIMIT %s OFFSET %s
        """, (customer_id, limit, offset))
        rows = cur.fetchall()

    result = []
    for r in rows:
        last_msg = r.get("last_message")
        if last_msg and len(last_msg) > 100:
            last_msg = last_msg[:100]
        last_msg_at = r.get("last_message_at")
        # last_message_at may be a datetime object or a raw string (SQLite)
        if last_msg_at is None:
            lma_ts = None
        elif hasattr(last_msg_at, "timestamp"):
            lma_ts = int(last_msg_at.timestamp())
        else:
            try:
                from datetime import datetime as _dt
                for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
                    try:
                        lma_ts = int(_dt.strptime(str(last_msg_at), fmt).timestamp())
                        break
                    except ValueError:
                        pass
                else:
                    lma_ts = None
            except Exception:
                lma_ts = None
        result.append({
            "id": r["id"],
            "category": r["category"],
            "status": r["status"],
            "created_at": int(r["created_at"].timestamp()) if r["created_at"] else 0,
            "last_message": last_msg,
            "last_message_at": lma_ts,
        })
    return result


def get_paginated_history(conversation_id: str, page: int = 1, limit: int = 10) -> list[dict]:
    """
    Return a page of messages for a conversation, newest-first pagination.
    Page 1 = most recent `limit` messages; page 2 = next oldest, etc.
    Messages are returned in chronological order within the page.
    """
    offset = (page - 1) * limit
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT sender_type, content, created_at, metadata
            FROM messages
            WHERE ticket_id = %s
              AND sender_type != 'internal_note'
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
        """, (conversation_id, limit, offset))
        rows = cur.fetchall()

    result = []
    for r in reversed(rows):  # return in chronological order within the page
        raw_meta = r["metadata"]
        meta = json.loads(raw_meta) if isinstance(raw_meta, str) and raw_meta else (raw_meta or {})
        if meta.get("is_internal_note"):
            continue
        entry: dict = {
            "role": _sender_type_to_role(r["sender_type"]),
            "content": r["content"],
            "created_at": int(r["created_at"].timestamp()) if r["created_at"] else 0,
        }
        if r["sender_type"] == "agent" and meta.get("agent_name"):
            entry["agent_name"] = meta["agent_name"]
            entry["agent_avatar"] = meta.get("agent_avatar", meta["agent_name"][0].upper())
            if meta.get("agent_avatar_url"):
                entry["agent_avatar_url"] = meta["agent_avatar_url"]
        result.append(entry)
    return result


def get_open_ticket_for_customer(user_id: str) -> dict | None:
    """
    Return the most recent Open_Live, Escalated, In_Progress, or Pending_Customer
    ticket for the given widget user_id, or None if no such ticket exists.
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM customers WHERE external_id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            return None
        customer_id = row["id"]

        cur.execute("""
            SELECT id, category, status, created_at
            FROM tickets
            WHERE customer_id = %s
              AND status IN ('Open_Live', 'Escalated', 'In_Progress', 'Pending_Customer')
            ORDER BY created_at DESC
            LIMIT 1
        """, (customer_id,))
        row = cur.fetchone()

    if not row:
        return None
    return {
        "id": row["id"],
        "category": row["category"],
        "status": row["status"],
        "created_at": int(row["created_at"].timestamp()) if row["created_at"] else 0,
    }


def get_or_create_customer_by_email(email: str, name: str = "") -> tuple[str | None, bool]:
    """
    Look up a customer by email address.

    Returns (customer_id, matched) where:
    - matched=True means the email was found in the customers table
    - matched=False means a new anonymous customer row was created

    Used exclusively by the email channel. The caller decides whether to
    proceed with account tools based on the matched flag.
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM customers WHERE email = %s", (email,))
        row = cur.fetchone()
        if row:
            return row["id"], True

        # Create anonymous customer — email only, no external_id
        customer_id = str(uuid.uuid4())
        display_name = name or email
        cur.execute("""
            INSERT INTO customers (id, name, email)
            VALUES (%s, %s, %s)
        """, (customer_id, display_name, email))
        return customer_id, False


def get_ticket_by_gmail_thread(gmail_thread_id: str) -> str | None:
    """
    Return the ticket_id for an existing Gmail thread, or None if new.
    Checks both tickets.gmail_thread_id and email_threads.gmail_message_id —
    because Gmail sometimes uses a sent message ID as the thread ID for replies.
    """
    with _conn() as conn:
        cur = conn.cursor()
        # Primary: match on thread ID stored in tickets
        cur.execute(
            "SELECT id FROM tickets WHERE gmail_thread_id = %s LIMIT 1",
            (gmail_thread_id,),
        )
        row = cur.fetchone()
        if row:
            return row["id"]
        # Fallback: the incoming thread_id might be a sent message ID we logged
        cur.execute(
            "SELECT ticket_id FROM email_threads WHERE gmail_message_id = %s LIMIT 1",
            (gmail_thread_id,),
        )
        row = cur.fetchone()
        return row["ticket_id"] if row else None


def create_email_ticket(
    *,
    gmail_thread_id: str,
    customer_id: str,
    subject: str,
    category: str | None,
) -> str:
    """
    Create a new ticket for an inbound email thread.
    Sets channel='email' and links the gmail_thread_id for future lookups.
    """
    ticket_id = str(uuid.uuid4())
    team = _CATEGORY_TEAM.get(category, "cs")
    with _conn() as conn:
        cur = conn.cursor()
        priority = _priority_for_customer(cur, customer_id)
        cur.execute("""
            INSERT INTO tickets
                (id, customer_id, channel, status, category, priority, team,
                 gmail_thread_id, subject)
            VALUES (%s, %s, 'email', 'Open_Live', %s, %s, %s, %s, %s)
        """, (
            ticket_id, customer_id,
            category or "unclassified", priority, team,
            gmail_thread_id, subject,
        ))
    return ticket_id


def update_ticket_category(conversation_id: str, category: str) -> None:
    team = _CATEGORY_TEAM.get(category, "cs")
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE tickets SET category = %s, team = %s, updated_at = NOW() WHERE id = %s",
            (category, team, conversation_id),
        )


def assign_ai_persona(conversation_id: str, name: str, avatar: str, avatar_url: str) -> None:
    persona = json.dumps({"ai_name": name, "ai_avatar": avatar, "ai_avatar_url": avatar_url})
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE tickets SET ai_persona = %s::jsonb, category = 'unclassified'
            WHERE id = %s
        """, (persona, conversation_id))


def get_ai_persona(conversation_id: str) -> dict:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT ai_persona FROM tickets WHERE id = %s", (conversation_id,))
        row = cur.fetchone()
    if not row or not row["ai_persona"]:
        return {"name": None, "avatar": None, "avatar_url": None}
    data = row["ai_persona"]
    return {"name": data.get("ai_name"), "avatar": data.get("ai_avatar"), "avatar_url": data.get("ai_avatar_url")}


# ── Messages ──────────────────────────────────────────────────────────────────

def add_message(conversation_id: str, role: str, content: str, metadata: dict = {}) -> str:
    """conversation_id here is the ticket_id in the dashboard schema."""
    msg_id = str(uuid.uuid4())
    sender_type = _role_to_sender_type(role)
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO messages (id, ticket_id, sender_type, content, metadata)
            VALUES (%s, %s, %s, %s, %s)
        """, (msg_id, conversation_id, sender_type, content, json.dumps(metadata)))
        # Touch ticket updated_at
        cur.execute("UPDATE tickets SET updated_at = NOW() WHERE id = %s", (conversation_id,))
    return msg_id


def get_history(conversation_id: str, limit: int = 10) -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT sender_type, content, created_at, metadata
            FROM messages
            WHERE ticket_id = %s
              AND sender_type != 'internal_note'
            ORDER BY created_at DESC
            LIMIT %s
        """, (conversation_id, limit))
        rows = cur.fetchall()
    result = []
    for r in reversed(rows):
        raw_meta = r["metadata"]
        meta = json.loads(raw_meta) if isinstance(raw_meta, str) and raw_meta else (raw_meta or {})
        # Belt-and-suspenders: also skip anything flagged internal in metadata
        if meta.get("is_internal_note"):
            continue
        entry: dict = {
            "role": _sender_type_to_role(r["sender_type"]),
            "content": r["content"],
            "created_at": int(r["created_at"].timestamp()) if r["created_at"] else 0,
        }
        if r["sender_type"] == "agent" and meta.get("agent_name"):
            entry["agent_name"] = meta["agent_name"]
            entry["agent_avatar"] = meta.get("agent_avatar", meta["agent_name"][0].upper())
            if meta.get("agent_avatar_url"):
                entry["agent_avatar_url"] = meta["agent_avatar_url"]
        result.append(entry)
    return result


def has_successful_bot_reply(conversation_id: str) -> bool:
    """
    Returns True if at least one bot message in this conversation was NOT an escalation.
    Used to decide whether to force a tool call again on retry turns.
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT metadata FROM messages
            WHERE ticket_id = %s AND sender_type = 'bot'
            ORDER BY created_at ASC
        """, (conversation_id,))
        rows = cur.fetchall()
    for r in rows:
        raw = r["metadata"]
        meta = json.loads(raw) if isinstance(raw, str) and raw else (raw or {})
        if not meta.get("escalated", False):
            return True
    return False


def count_consecutive_low_confidence(conversation_id: str) -> int:
    """
    Count consecutive recent bot messages with confidence < threshold.
    Computed server-side from message metadata so the client cannot spoof it.
    """
    from config.settings import ESCALATION_CONFIDENCE_THRESHOLD
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT metadata
            FROM messages
            WHERE ticket_id = %s AND sender_type = 'bot'
            ORDER BY created_at DESC
            LIMIT 10
        """, (conversation_id,))
        rows = cur.fetchall()
    count = 0
    for r in rows:
        raw = r["metadata"]
        meta = json.loads(raw) if isinstance(raw, str) and raw else (raw or {})
        confidence = meta.get("confidence")
        if confidence is not None and float(confidence) < ESCALATION_CONFIDENCE_THRESHOLD:
            count += 1
        else:
            break
    return count


# ── Tickets ───────────────────────────────────────────────────────────────────

def create_ticket(conversation_id: str, escalation_reason: str) -> str:
    """
    In the unified schema the ticket already exists (created in create_conversation).
    On escalation we update its status and return the same ticket ID.
    """
    if escalation_reason == "ai_handling":
        # Initial creation — ticket already created; just return the id
        return conversation_id

    # Real escalation — mark ticket as Escalated
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE tickets
            SET status = 'Escalated', updated_at = NOW()
            WHERE id = %s
        """, (conversation_id,))
    return conversation_id


def get_ticket_id_by_conversation(conversation_id: str) -> str | None:
    """In the unified schema, conversation_id == ticket_id."""
    return conversation_id


def is_human_handling(conversation_id: str) -> bool:
    """
    Returns True if a human agent has taken over this conversation.
    Condition: status is 'Escalated' OR a human agent is assigned (assigned_to is set).
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT status, assigned_to FROM tickets WHERE id = %s", (conversation_id,))
        row = cur.fetchone()
    if not row:
        return False
    return row["status"] == "Escalated" or row["assigned_to"] is not None


def has_human_agent_replied(conversation_id: str) -> bool:
    """
    Returns True if a human agent has sent at least one real reply on this conversation.
    Internal notes do not count — only sender_type='agent' messages.
    Used to determine when the AI should go permanently silent after escalation.
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM messages WHERE ticket_id = %s AND sender_type = 'agent' LIMIT 1",
            (conversation_id,),
        )
        return cur.fetchone() is not None


def update_ticket_status(ticket_id: str, status: str, agent_id: str | None = None) -> None:
    # Map Python status names → dashboard status enum
    STATUS_MAP = {
        "ai_handling": "Open_Live",
        "pending_human": "Escalated",
        "unresponsive": "Closed_Unresponsive",
        "assigned": "In_Progress",
        "pending_customer": "Pending_Customer",
        "pending_internal": "Pending_Customer",
        "transferred": "In_Progress",
        "snoozed": "Pending_Customer",
        "blocked": "Pending_Customer",
        "resolved": "Closed_Resolved",
        "closed": "Closed_Resolved",
        "in_progress": "In_Progress",
        "escalated": "Escalated",
        "spam": "Closed_Unresponsive",
        # Pass-through dashboard statuses
        "Open_Live": "Open_Live",
        "In_Progress": "In_Progress",
        "Pending_Customer": "Pending_Customer",
        "Closed_Resolved": "Closed_Resolved",
        "Closed_Unresponsive": "Closed_Unresponsive",
        "Escalated": "Escalated",
    }
    pg_status = STATUS_MAP.get(status, "Open_Live")
    with _conn() as conn:
        cur = conn.cursor()
        if agent_id:
            cur.execute("""
                UPDATE tickets SET status = %s, assigned_to = %s::uuid, updated_at = NOW()
                WHERE id = %s
            """, (pg_status, agent_id, ticket_id))
        else:
            cur.execute("""
                UPDATE tickets SET status = %s, updated_at = NOW()
                WHERE id = %s
            """, (pg_status, ticket_id))


def submit_csat_score(ticket_id: str, score: int) -> None:
    """Store customer CSAT rating and mark ticket resolved."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE tickets
            SET csat_score = %s,
                status = 'Closed_Resolved',
                updated_at = NOW()
            WHERE id = %s
        """, (score, ticket_id))


def transfer_ticket(ticket_id: str, transferred_to: str, agent_id: str | None = None) -> None:
    update_ticket_status(ticket_id, "transferred", agent_id)


def snooze_ticket(ticket_id: str, snooze_until_timestamp: int, agent_id: str | None = None) -> None:
    update_ticket_status(ticket_id, "snoozed", agent_id)


def block_ticket(ticket_id: str, blocked_on: str, agent_id: str | None = None) -> None:
    update_ticket_status(ticket_id, "blocked", agent_id)


def set_pending_internal(ticket_id: str, blocked_on: str, agent_id: str | None = None) -> None:
    update_ticket_status(ticket_id, "pending_internal", agent_id)


# ── Dashboard queries ─────────────────────────────────────────────────────────

def get_all_conversations() -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                t.id,
                c.id AS user_id,
                t.channel AS platform,
                'en' AS language,
                t.status,
                EXTRACT(EPOCH FROM t.created_at)::bigint AS created_at,
                EXTRACT(EPOCH FROM t.updated_at)::bigint AS updated_at,
                t.id AS ticket_id,
                t.status AS ticket_status,
                t.category AS escalation_reason,
                (SELECT content FROM messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                c.name AS customer_name
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            ORDER BY t.updated_at DESC
            LIMIT 200
        """)
        rows = cur.fetchall()
    return [dict(r) for r in rows]


def get_conversation_with_history(conversation_id: str) -> dict | None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.*, c.id AS cust_id, c.name AS customer_name, c.email AS customer_email
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.id = %s
        """, (conversation_id,))
        ticket = cur.fetchone()
        if not ticket:
            return None
        ticket = dict(ticket)

        cur.execute("""
            SELECT sender_type, content,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at
            FROM messages
            WHERE ticket_id = %s
            ORDER BY created_at ASC
        """, (conversation_id,))
        msgs = cur.fetchall()

    result = {
        "id": ticket["id"],
        "user_id": ticket["cust_id"],
        "platform": ticket["channel"],
        "language": "en",
        "status": ticket["status"],
        "created_at": int(ticket["created_at"].timestamp()) if ticket.get("created_at") else 0,
        "updated_at": int(ticket["updated_at"].timestamp()) if ticket.get("updated_at") else 0,
        "ai_agent_name": None,
        "ai_agent_avatar": None,
        "ai_agent_avatar_url": None,
        "ticket": {
            "id": ticket["id"],
            "status": ticket["status"],
            "escalation_reason": ticket.get("category") or "unclassified",
            "assigned_agent_id": str(ticket["assigned_to"]) if ticket.get("assigned_to") else None,
        },
        "history": [
            {
                "role": _sender_type_to_role(m["sender_type"]),
                "content": m["content"],
                "created_at": m["created_at"],
            }
            for m in msgs
        ],
    }
    # Merge persona if stored
    persona = get_ai_persona(conversation_id)
    result["ai_agent_name"] = persona["name"]
    result["ai_agent_avatar"] = persona["avatar"]
    result["ai_agent_avatar_url"] = persona["avatar_url"]
    return result


_VALID_STATUSES = {
    'Open_Live', 'In_Progress', 'Pending_Customer',
    'Escalated', 'Closed_Resolved', 'Closed_Unresponsive', 'Orphaned',
}


def get_open_tickets(search: str = "", status_filter: str = "open") -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        base_query = """
            SELECT
                t.id,
                t.status,
                t.channel,
                t.category,
                t.priority,
                t.assigned_to,
                t.assigned_to AS assigned_agent_id,
                EXTRACT(EPOCH FROM t.created_at)::bigint AS created_at,
                EXTRACT(EPOCH FROM t.updated_at)::bigint AS updated_at,
                (SELECT content FROM messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                (SELECT EXTRACT(EPOCH FROM created_at)::bigint FROM messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
                c.id        AS cust_id,
                c.name      AS cust_name,
                c.email     AS cust_email,
                c.phone     AS cust_phone,
                c.tier      AS cust_tier,
                c.kyc_status AS cust_kyc_status,
                c.external_id AS cust_external_id
            FROM tickets t
            JOIN customers c ON t.customer_id = c.id
            WHERE 1=1
        """
        params: list = []
        if status_filter in _VALID_STATUSES:
            base_query += " AND t.status = %s"
            params.append(status_filter)
        elif status_filter != "all":
            # default: hide closed tickets (legacy "all_open" behaviour)
            base_query += " AND t.status NOT IN ('Closed_Resolved', 'Closed_Unresponsive')"
        if search:
            term = f"%{search.lower()}%"
            base_query += """
            AND (
                LOWER(t.id::text) LIKE %s
                OR LOWER(c.name) LIKE %s
                OR LOWER(c.email) LIKE %s
                OR LOWER(c.external_id) LIKE %s
            )
            """
            params.extend([term, term, term, term])
        base_query += " ORDER BY t.priority ASC, t.updated_at DESC"
        cur.execute(base_query, params)
        rows = cur.fetchall()

    result = []
    for r in rows:
        ticket = dict(r)
        result.append({
            "id":               ticket["id"],
            "status":           ticket["status"],
            "channel":          ticket["channel"],
            "category":         ticket["category"],
            "priority":         ticket["priority"] or 3,
            "assigned_to":      str(ticket["assigned_to"]) if ticket.get("assigned_to") else None,
            "assigned_agent_id": str(ticket["assigned_agent_id"]) if ticket.get("assigned_agent_id") else None,
            "created_at":       ticket["created_at"],
            "updated_at":       ticket["updated_at"],
            "last_message":     ticket["last_message"],
            "last_message_at":  ticket["last_message_at"],
            "tags":             get_tags_for_ticket(ticket["id"]),
            "customer": {
                "id":          ticket["cust_id"],
                "user_id":     ticket["cust_external_id"] or ticket["cust_id"],
                "name":        ticket["cust_name"] or "—",
                "email":       ticket["cust_email"],
                "phone":       ticket["cust_phone"],
                "tier":        ticket["cust_tier"] or "regular",
                "kyc_status":  ticket["cust_kyc_status"],
            },
        })
    return result


def get_ticket_stats() -> dict:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'Open_Live')           AS open,
                COUNT(*) FILTER (WHERE status = 'In_Progress')         AS active,
                COUNT(*) FILTER (WHERE status = 'Escalated')           AS escalated,
                COUNT(*) FILTER (WHERE status = 'Pending_Customer')    AS pending,
                COUNT(*) FILTER (WHERE status = 'Closed_Resolved')     AS resolved,
                COUNT(*) FILTER (WHERE status = 'Closed_Unresponsive') AS closed
            FROM tickets
        """)
        row = dict(cur.fetchone())
    return {k: int(v or 0) for k, v in row.items()}


def get_ticket_with_history(ticket_id: str) -> dict | None:
    return get_conversation_with_history(ticket_id)


def get_ticket_by_id(ticket_id: str) -> dict | None:
    """Return a single ticket row by id, or None if not found."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM tickets WHERE id = %s", (ticket_id,))
        row = cur.fetchone()
        return dict(row) if row else None


# ── Tags ──────────────────────────────────────────────────────────────────────

def get_all_tags() -> list[str]:
    """Return all tag names in alphabetical order."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT name FROM tags ORDER BY name")
        return [r["name"] for r in cur.fetchall()]


def create_tag(name: str) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO tags (id, name) VALUES (gen_random_uuid(), %s) ON CONFLICT (name) DO NOTHING",
            (name,)
        )


def delete_tag(name: str) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM tags WHERE name = %s", (name,))


def get_tags_for_ticket(ticket_id: str) -> list[str]:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.name FROM tags t
            JOIN ticket_tags tt ON tt.tag_id = t.id
            WHERE tt.ticket_id = %s
            ORDER BY t.name
        """, (ticket_id,))
        return [r["name"] for r in cur.fetchall()]


def set_tags_for_ticket(ticket_id: str, tag_names: list[str]) -> None:
    """Replace the full tag set for a ticket. Creates new tags on the fly."""
    with _conn() as conn:
        cur = conn.cursor()
        # Ensure all tags exist (tags.id is UUID, use gen_random_uuid())
        for name in tag_names:
            cur.execute(
                "INSERT INTO tags (id, name) VALUES (gen_random_uuid(), %s) ON CONFLICT (name) DO NOTHING",
                (name,)
            )
        # Replace ticket_tags
        cur.execute("DELETE FROM ticket_tags WHERE ticket_id = %s", (ticket_id,))
        if tag_names:
            cur.execute("SELECT id, name FROM tags WHERE name = ANY(%s)", (tag_names,))
            tag_ids = [r["id"] for r in cur.fetchall()]
            for tag_id in tag_ids:
                cur.execute(
                    "INSERT INTO ticket_tags (ticket_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (ticket_id, tag_id)
                )


# ── Auto-transitions ──────────────────────────────────────────────────────────

def get_tickets_for_auto_transition() -> dict:
    """Returns tickets eligible for automatic status transitions."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT * FROM tickets
            WHERE status = 'Pending_Customer'
              AND updated_at < NOW() - INTERVAL '2 hours'
        """)
        pending_customer_expired = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT * FROM tickets
            WHERE status = 'Closed_Resolved'
              AND updated_at < NOW() - INTERVAL '24 hours'
        """)
        resolved_expired = [dict(r) for r in cur.fetchall()]

    return {
        "pending_customer_expired": pending_customer_expired,
        "snoozed_expired": [],
        "resolved_expired": resolved_expired,
    }


# ── Agents (users table) ──────────────────────────────────────────────────────

def get_agents(include_inactive: bool = False) -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        if include_inactive:
            cur.execute("SELECT id, name, email, role, state, team, active_chats, max_chats, skills, shift, active, avatar_url FROM users ORDER BY name")
        else:
            cur.execute("SELECT id, name, email, role, state, team, active_chats, max_chats, skills, shift, active, avatar_url FROM users WHERE active = true ORDER BY name")
        return [dict(r) for r in cur.fetchall()]


def get_agent(agent_id: str) -> dict | None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, name, email, role, state, team, active_chats, max_chats, skills, shift, active, avatar_url FROM users WHERE id = %s", (agent_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def get_agent_by_email(email: str) -> dict | None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, name, email, role, state, team, active_chats, max_chats, skills, shift, active, avatar_url, password_hash FROM users WHERE email = %s", (email.lower(),))
        row = cur.fetchone()
        return dict(row) if row else None


def create_agent(name: str, email: str, password_hash: str, role: str, team: str = "cs", max_chats: int = 3, skills: list = [], shift: str | None = None) -> dict:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO users (name, email, password_hash, role, team, max_chats, skills, shift)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (name, email.lower(), password_hash, role, team, max_chats, skills, shift)
        )
        new_id = cur.fetchone()["id"]
    return get_agent(str(new_id))


def update_agent(agent_id: str, fields: dict) -> dict | None:
    allowed = {"name", "role", "team", "max_chats", "skills", "shift", "avatar_url"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_agent(agent_id)
    with _conn() as conn:
        cur = conn.cursor()
        set_clause = ", ".join(f"{k} = %s" for k in updates)
        cur.execute(f"UPDATE users SET {set_clause}, updated_at = NOW() WHERE id = %s", (*updates.values(), agent_id))
    return get_agent(agent_id)


def set_agent_active(agent_id: str, active: bool) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET active = %s, updated_at = NOW() WHERE id = %s", (active, agent_id))


def set_agent_password(agent_id: str, password_hash: str) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET password_hash = %s, updated_at = NOW() WHERE id = %s", (password_hash, agent_id))


def set_agent_state(agent_id: str, state: str) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET state = %s, updated_at = NOW() WHERE id = %s", (state, agent_id))


# ── Roles ─────────────────────────────────────────────────────────────────────

def get_roles() -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT name, display_name, is_preset FROM roles ORDER BY name")
        roles = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT role_name, permission FROM role_permissions ORDER BY role_name, permission")
        perms: dict[str, list[str]] = {}
        for row in cur.fetchall():
            perms.setdefault(row["role_name"], []).append(row["permission"])
        for r in roles:
            r["permissions"] = perms.get(r["name"], [])
        return roles


def create_role(name: str, display_name: str = "", permissions: list = []) -> dict:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO roles (name, display_name) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
            (name, display_name or name)
        )
        cur.execute("DELETE FROM role_permissions WHERE role_name = %s", (name,))
        for perm in permissions:
            cur.execute("INSERT INTO role_permissions (role_name, permission) VALUES (%s, %s) ON CONFLICT DO NOTHING", (name, perm))
    return {"name": name, "display_name": display_name or name, "permissions": permissions}


def update_role(name: str, fields: dict) -> dict | None:
    with _conn() as conn:
        cur = conn.cursor()
        if "display_name" in fields:
            cur.execute("UPDATE roles SET display_name = %s WHERE name = %s", (fields["display_name"], name))
        if "permissions" in fields:
            cur.execute("DELETE FROM role_permissions WHERE role_name = %s", (name,))
            for perm in fields["permissions"]:
                cur.execute("INSERT INTO role_permissions (role_name, permission) VALUES (%s, %s) ON CONFLICT DO NOTHING", (name, perm))
    roles = get_roles()
    return next((r for r in roles if r["name"] == name), None)


def delete_role(name: str) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM roles WHERE name = %s", (name,))


# ── Knowledge Base ─────────────────────────────────────────────────────────────

def create_knowledge_item(title: str, source_type: str, source_ref: str | None, chunk_count: int, created_by: str | None) -> dict:
    # created_by must be a valid UUID; fall back to NULL for non-UUID values (e.g. dev fallback)
    import uuid as _uuid
    try:
        creator_id = str(_uuid.UUID(created_by)) if created_by else None
    except (ValueError, AttributeError):
        creator_id = None
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO knowledge_items (title, source_type, source_ref, chunk_count, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, title, source_type, source_ref, chunk_count, created_by,
                      EXTRACT(EPOCH FROM created_at)::bigint AS created_at
        """, (title, source_type, source_ref, chunk_count, creator_id))
        return dict(cur.fetchone())


def list_knowledge_items() -> list[dict]:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, title, source_type, source_ref, chunk_count, created_by,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at
            FROM knowledge_items
            ORDER BY created_at DESC
        """)
        return [dict(r) for r in cur.fetchall()]


def get_knowledge_item(item_id: int) -> dict | None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, title, source_type, source_ref, chunk_count, created_by,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at
            FROM knowledge_items WHERE id = %s
        """, (item_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def delete_knowledge_item(item_id: int) -> bool:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM knowledge_items WHERE id = %s", (item_id,))
        return cur.rowcount > 0


def log_ai_draft(
    ticket_id: str,
    agent_id: str,
    instruction: str,
    partial_draft: str,
    generated: str,
) -> None:
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO ai_drafts (ticket_id, agent_id, instruction, partial_draft, generated)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (ticket_id, agent_id or None, instruction, partial_draft, generated),
        )


# ── Gmail history cursor (safety-net polling bookmark) ────────────────────────

def get_gmail_history_cursor() -> str | None:
    """Return the stored historyId bookmark, or None if table is empty."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT history_id FROM gmail_history_cursor WHERE id = 1")
        row = cur.fetchone()
        return row["history_id"] if row else None


def set_gmail_history_cursor(history_id: str) -> None:
    """Upsert the historyId bookmark (single row, id=1)."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO gmail_history_cursor (id, history_id, updated_at)
            VALUES (1, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET history_id = EXCLUDED.history_id, updated_at = NOW()
        """, (history_id,))


def get_unreplied_email_tickets() -> list[dict]:
    """
    Return email tickets that have at least one inbound message in email_threads
    but no outbound message — meaning we received the email but never replied.
    Excludes tickets in terminal states (Closed_*, Resolved) and tickets that
    are pending_customer waiting for the customer to act (e.g. verification sent).
    """
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                t.id        AS ticket_id,
                t.status,
                t.gmail_thread_id,
                t.subject,
                t.category,
                c.email     AS customer_email,
                c.name      AS customer_name,
                c.id        AS customer_id
            FROM tickets t
            JOIN customers c ON c.id = t.customer_id
            WHERE t.channel = 'email'
              AND t.status NOT IN ('Closed_Resolved', 'Closed_Unresponsive', 'Pending_Customer', 'Resolved', 'Escalated')
              AND EXISTS (
                  SELECT 1 FROM email_threads et
                  WHERE et.ticket_id = t.id AND et.direction = 'inbound'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM email_threads et
                  WHERE et.ticket_id = t.id AND et.direction = 'outbound'
              )
              AND t.created_at > NOW() - INTERVAL '7 days'
        """)
        return [dict(r) for r in cur.fetchall()]


def backfill_outbound_message(
    ticket_id: str,
    gmail_thread_id: str,
    gmail_message_id: str,
    from_email: str,
    subject: str,
    content: str,
    sent_at: str,
) -> None:
    """
    Write a sent Gmail message into our DB that was never recorded.
    Called when the safety-net scanner finds an outbound message in Gmail
    but no matching row in email_threads.
    """
    from db.email_store import log_email_message
    log_email_message(
        ticket_id=ticket_id,
        gmail_thread_id=gmail_thread_id,
        gmail_message_id=gmail_message_id,
        direction="outbound",
        from_email=from_email,
        from_name="Bitazza Support",
        subject=subject,
        snippet=content[:200],
        attachments=[],
        raw_headers={},
    )
    # Also write to messages table so dashboard history is complete
    add_message(ticket_id, "assistant", content, metadata={
        "channel": "email",
        "gmail_message_id": gmail_message_id,
        "backfilled": True,
        "sent_at": sent_at,
    })
