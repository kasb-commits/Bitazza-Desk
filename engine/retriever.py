"""
RAG retriever — queries the vector store for relevant knowledge chunks.
"""
import logging

from db.vector_store import query
from config.settings import MAX_RAG_CHUNKS

logger = logging.getLogger(__name__)

# Gemini embedding-001 cosine distances: <0.35 = strong match, <0.55 = relevant
_DISTANCE_THRESHOLD = 0.55

# Exclude Freshdesk ticket chunks from all retrieval — they describe specific user problems
# and add noise. Only documentation and blog chunks are used for KB answers.
_EXCLUDE_TICKETS = {"doc_type": {"$ne": "ticket"}}


def retrieve(user_message: str, n: int = MAX_RAG_CHUNKS) -> list[dict]:
    """
    Returns top-n relevant knowledge chunks for the given user message.
    Each chunk: {text, metadata: {source, doc_type, ...}, distance}
    Ticket chunks are always excluded — only docs and blog content are returned.
    """
    chunks = query(user_message, n_results=n, where=_EXCLUDE_TICKETS)
    filtered = [c for c in chunks if (c.get("distance") or 1.0) < _DISTANCE_THRESHOLD]
    return filtered


def retrieve_with_fallback(user_message: str, n: int = MAX_RAG_CHUNKS) -> list[dict]:
    """
    Retrieves chunks; returns empty list gracefully if vector DB is empty or unavailable.
    """
    try:
        return retrieve(user_message, n)
    except Exception:
        logger.exception("Vector DB unavailable or empty — returning no chunks")
        return []
