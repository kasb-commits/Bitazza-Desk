"""
RAG retriever — queries the vector store for relevant knowledge chunks.
"""
import logging
import time

from db.vector_store import query
from config.settings import MAX_RAG_CHUNKS

logger = logging.getLogger(__name__)

# Gemini embedding-001 cosine distances: <0.35 = strong match, <0.55 = relevant
_DISTANCE_THRESHOLD = 0.55

# Exclude ticket chunks (noise) and ARCHIVED version chunks (superseded content).
# Chunks without a 'status' key (pre-migration data) pass the $ne filter because
# _translate_where generates: (metadata->>'status' IS NULL OR metadata->>'status' != 'ARCHIVED')
_EXCLUDE_INACTIVE = {"doc_type": {"$ne": "ticket"}, "status": {"$ne": "ARCHIVED"}}


def retrieve(user_message: str, n: int = MAX_RAG_CHUNKS) -> list[dict]:
    """
    Returns top-n relevant knowledge chunks for the given user message.
    Each chunk: {text, metadata: {source, doc_type, ...}, distance}
    Ticket chunks and ARCHIVED version chunks are always excluded.
    """
    chunks = query(user_message, n_results=n, where=_EXCLUDE_INACTIVE)
    filtered = [c for c in chunks if (c.get("distance") or 1.0) < _DISTANCE_THRESHOLD]
    return filtered


def retrieve_with_fallback(user_message: str, n: int = MAX_RAG_CHUNKS) -> list[dict]:
    """
    Retrieves chunks; returns empty list gracefully if vector DB is empty or unavailable.
    """
    _t = time.time()
    try:
        chunks_raw = retrieve(user_message, n)
        logger.info("retriever_complete", extra={
            "num_results": len(chunks_raw),
            "latency_ms": round((time.time() - _t) * 1000, 1),
            "threshold": _DISTANCE_THRESHOLD,
        })
        return chunks_raw
    except Exception:
        logger.exception("Vector DB unavailable or empty — returning no chunks")
        return []
