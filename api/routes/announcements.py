"""Public endpoint for active announcements — called by the chat widget."""
from fastapi import APIRouter
from db.conversation_store import _conn

router = APIRouter(prefix="/chat", tags=["announcements"])


@router.get("/announcement")
def get_active_announcements():
    """
    Return all currently active announcements within their date window.
    Public — no auth required. Widget calls this after language selection.
    """
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, title_en, body_en, title_th, body_th, color
                FROM announcements
                WHERE active = true
                  AND (starts_at IS NULL OR starts_at <= NOW())
                  AND (ends_at   IS NULL OR ends_at   >  NOW())
                ORDER BY created_at DESC
                """
            )
            rows = cur.fetchall()
    return {"announcements": [dict(r) for r in rows]}
