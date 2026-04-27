"""Notification CRUD helpers — used by api/routes/notifications.py and event hooks."""
import uuid
from contextlib import contextmanager
from db.conversation_store import _conn


def get_supervisor_ids() -> list[str]:
    """Return all active supervisor/admin user IDs for fan-out notifications."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM users WHERE role IN ('supervisor', 'admin', 'super_admin') AND active = TRUE"
        )
        return [str(r["id"]) for r in cur.fetchall()]


def create_notification(
    user_id: str,
    role: str,
    type: str,
    priority: str,
    title: str,
    body: str,
    ticket_id: str | None = None,
) -> dict:
    """Insert a notification row and return it."""
    nid = str(uuid.uuid4())
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, user_id, role, type, priority, title, body, ticket_id, read, created_at
            """,
            (nid, user_id, role, type, priority, title, body, ticket_id),
        )
        row = dict(cur.fetchone())
        row["created_at"] = row["created_at"].isoformat()
        return row


def fan_out_to_supervisors(
    type: str,
    priority: str,
    title: str,
    body: str,
    ticket_id: str | None = None,
) -> list[dict]:
    """Create a notification for every active supervisor/admin. Returns list of created rows."""
    supervisor_ids = get_supervisor_ids()
    results = []
    for uid in supervisor_ids:
        notif = create_notification(
            user_id=uid,
            role="supervisor",
            type=type,
            priority=priority,
            title=title,
            body=body,
            ticket_id=ticket_id,
        )
        results.append(notif)
    return results


def get_notifications(user_id: str, limit: int = 50) -> list[dict]:
    """Fetch the most recent notifications for a user."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, user_id, role, type, priority, title, body, ticket_id, read, created_at
            FROM notifications
            WHERE user_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        rows = []
        for r in cur.fetchall():
            row = dict(r)
            row["created_at"] = row["created_at"].isoformat()
            rows.append(row)
        return rows


def mark_read(notif_id: str, user_id: str) -> bool:
    """Mark a single notification as read. Returns True if found and updated."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE notifications SET read = TRUE WHERE id = %s AND user_id = %s",
            (notif_id, user_id),
        )
        return cur.rowcount > 0


def mark_all_read(user_id: str) -> int:
    """Mark all unread notifications as read for a user. Returns count updated."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE notifications SET read = TRUE WHERE user_id = %s AND read = FALSE",
            (user_id,),
        )
        return cur.rowcount


def notification_recently_exists(ticket_id: str, notif_type: str, within_seconds: int = 3600) -> bool:
    """Return True if a notification of the given type for this ticket was created recently."""
    with _conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT 1 FROM notifications
            WHERE ticket_id = %s AND type = %s
              AND created_at > NOW() - (%s * INTERVAL '1 second')
            LIMIT 1
            """,
            (ticket_id, notif_type, within_seconds),
        )
        return cur.fetchone() is not None

