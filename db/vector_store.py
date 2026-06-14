"""
Vector store backed by pgvector (PostgreSQL).

Embedding model: Gemini text-embedding-001 (3072-dim, semantic).
Falls back to word-hash embedding if GEMINI_API_KEY is unavailable.

Gemini cosine distances: <0.35 = strong match, <0.55 = relevant.

Table: vector_embeddings (created by migration 015_pgvector.sql)
"""
import hashlib, json, logging, math, re, time
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

from config import settings

logger = logging.getLogger(__name__)

DATABASE_URL = settings.DATABASE_URL

# ── Gemini embedding ──────────────────────────────────────────────────────────

_EMBED_MODEL = "models/gemini-embedding-001"
_EMBED_BATCH  = 20   # Gemini embedding API batch size limit
_EMBED_RPM    = 1500 # requests-per-minute quota; batch of 20 = 75 batches/min max

_gemini_client = None


def _get_gemini_client():
    global _gemini_client
    if _gemini_client is not None:
        return _gemini_client
    try:
        from google import genai as _genai
        from config.settings import GEMINI_API_KEY
        if not GEMINI_API_KEY:
            raise ValueError("GEMINI_API_KEY not set")
        _gemini_client = _genai.Client(api_key=GEMINI_API_KEY)
        return _gemini_client
    except Exception as exc:
        logger.warning("Gemini embedding unavailable (%s) — falling back to word-hash", exc)
        return None


def _gemini_embed_batch(texts: list[str]) -> list[list[float]] | None:
    """
    Embed a list of texts via Gemini embedContent (one call per text).
    Passing a single-item list to the SDK avoids batchEmbedContents,
    which is restricted on some API keys/IPs.
    Returns None on any failure — caller falls back to word-hash.
    """
    client = _get_gemini_client()
    if client is None:
        return None
    try:
        results = []
        for text in texts:
            r = client.models.embed_content(model=_EMBED_MODEL, contents=[text])
            results.append(list(r.embeddings[0].values))
        return results
    except Exception as exc:
        logger.warning("Gemini embed_content failed: %s — falling back to word-hash", exc)
        return None


# ── Word-hash fallback embedding ──────────────────────────────────────────────

_DIM = 3072  # Match Gemini dim so collections stay compatible if we switch mid-run

_STOP = {
    "the","a","an","is","it","to","of","and","in","for","on","with","my","i",
    "me","you","your","we","be","have","has","was","are","do","did","not","or",
    "at","by","this","that","can","will","please","help","hi","hello","dear",
}


def _word_embed(text: str) -> list[float]:
    """Word-level hashed embedding — used only when Gemini API is unreachable."""
    vec = [0.0] * _DIM
    words = re.findall(r"[a-z0-9_]+|[\u0e00-\u0e7f]+", text.lower())
    word_counts: dict[str, int] = {}
    for w in words:
        if w not in _STOP and len(w) > 1:
            word_counts[w] = word_counts.get(w, 0) + 1
    for w, count in word_counts.items():
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        idx = h % _DIM
        vec[idx] += math.log1p(count)
    word_list = [w for w in words if w not in _STOP and len(w) > 1]
    for i in range(len(word_list) - 1):
        bigram = word_list[i] + "_" + word_list[i+1]
        h = int(hashlib.md5(bigram.encode()).hexdigest(), 16)
        idx = h % _DIM
        vec[idx] += 0.5
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def _embed_one(text: str) -> list[float]:
    """Single-text embedding with word-hash fallback."""
    result = _gemini_embed_batch([text])
    return result[0] if result else _word_embed(text)


def _vec_to_sql(vec: list[float]) -> str:
    """Convert a float list to the pgvector literal string '[0.1,0.2,...]'."""
    return "[" + ",".join(map(str, vec)) + "]"


# ── DB connection ─────────────────────────────────────────────────────────────

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


# ── Where-clause translator ───────────────────────────────────────────────────

def _translate_where(where: dict) -> tuple[str, list]:
    """
    Translate a subset of ChromaDB where-clause syntax to SQL fragments.
    Supports $eq, $ne, $in on top-level keys.
    Keys named 'doc_type' map to the native column; others map to metadata JSONB.
    Returns (sql_fragment, params_list).
    """
    clauses, params = [], []
    for key, condition in where.items():
        col = "doc_type" if key == "doc_type" else f"metadata->>'{key}'"
        if isinstance(condition, dict):
            op, val = next(iter(condition.items()))
            if op == "$eq":
                clauses.append(f"{col} = %s")
                params.append(val)
            elif op == "$ne":
                clauses.append(f"({col} IS NULL OR {col} != %s)")
                params.append(val)
            elif op == "$in":
                ph = ",".join(["%s"] * len(val))
                clauses.append(f"{col} IN ({ph})")
                params.extend(val)
        else:
            clauses.append(f"{col} = %s")
            params.append(condition)
    return (" AND ".join(clauses) if clauses else "TRUE"), params


# ── Public API ────────────────────────────────────────────────────────────────

def upsert_documents(docs: list[dict], collection_name: str = "knowledge_base") -> None:
    """
    docs: list of {id, text, metadata}
    Embeds each document and upserts into vector_embeddings.
    """
    if not docs:
        return

    texts = [d["text"] for d in docs]

    # Batch-embed in groups of _EMBED_BATCH
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH):
        batch = texts[start:start + _EMBED_BATCH]
        vecs = _gemini_embed_batch(batch)
        if vecs is not None:
            embeddings.extend(vecs)
        else:
            embeddings.extend(_word_embed(t) for t in batch)
        if start + _EMBED_BATCH < len(texts):
            time.sleep(0.05)

    with _conn() as conn:
        cur = conn.cursor()
        for doc, vec in zip(docs, embeddings):
            meta = doc.get("metadata") or {}
            doc_type = meta.get("doc_type")
            cur.execute(
                """
                INSERT INTO vector_embeddings
                    (external_id, collection, content, embedding, doc_type, metadata)
                VALUES (%s, %s, %s, %s::vector, %s, %s)
                ON CONFLICT (collection, external_id) DO UPDATE SET
                    content   = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    doc_type  = EXCLUDED.doc_type,
                    metadata  = EXCLUDED.metadata
                """,
                (
                    doc["id"],
                    collection_name,
                    doc["text"],
                    _vec_to_sql(vec),
                    doc_type,
                    json.dumps(meta),
                ),
            )


def query(
    text: str,
    n_results: int = 5,
    collection_name: str = "knowledge_base",
    where: dict | None = None,
) -> list[dict]:
    """
    Embeds text and returns top-n nearest chunks with metadata and distance.
    Optionally filters by metadata via a ChromaDB-style where dict.
    """
    vec_str = _vec_to_sql(_embed_one(text))
    where_sql, where_params = _translate_where(where) if where else ("TRUE", [])

    sql = f"""
        SELECT content, metadata, doc_type,
               embedding <=> %s::vector AS distance
        FROM vector_embeddings
        WHERE collection = %s
          AND {where_sql}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s
    """
    params = [vec_str, collection_name] + where_params + [vec_str, n_results]

    try:
        with _conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, params)
            rows = cur.fetchall()
    except Exception:
        logger.exception("Vector query failed — returning no chunks")
        return []

    results = []
    for row in rows:
        meta = row["metadata"] if isinstance(row["metadata"], dict) else {}
        if row["doc_type"]:
            meta = {**meta, "doc_type": row["doc_type"]}
        results.append({
            "text": row["content"],
            "metadata": meta,
            "distance": float(row["distance"]) if row["distance"] is not None else None,
        })
    return results


def delete_by_metadata(
    filter_key: str,
    filter_value: str,
    collection_name: str = "knowledge_base",
) -> int:
    """Delete all chunks where metadata[filter_key] == filter_value. Returns count deleted."""
    try:
        with _conn() as conn:
            cur = conn.cursor()
            if filter_key == "doc_type":
                cur.execute(
                    "DELETE FROM vector_embeddings WHERE collection = %s AND doc_type = %s",
                    (collection_name, filter_value),
                )
            else:
                cur.execute(
                    "DELETE FROM vector_embeddings WHERE collection = %s AND metadata->>%s = %s",
                    (collection_name, filter_key, filter_value),
                )
            return cur.rowcount
    except Exception:
        logger.exception("delete_by_metadata failed for %s=%s", filter_key, filter_value)
        return 0


def collection_count(collection_name: str = "knowledge_base") -> int:
    """Return total number of chunks in the collection."""
    try:
        with _conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT COUNT(*) AS n FROM vector_embeddings WHERE collection = %s",
                (collection_name,),
            )
            row = cur.fetchone()
            return int(row["n"]) if row else 0
    except Exception:
        logger.exception("collection_count failed — returning 0")
        return 0


def get_chunks_by_item(item_id: int) -> list[dict]:
    """
    Return all indexed text chunks for a knowledge item, ordered by chunk_index.
    Used by the /api/knowledge/{item_id}/chunks endpoint.
    """
    try:
        with _conn() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT content, metadata
                FROM vector_embeddings
                WHERE collection = 'knowledge_base'
                  AND metadata->>'knowledge_item_id' = %s
                ORDER BY (metadata->>'chunk_index')::int ASC
                """,
                (str(item_id),),
            )
            rows = cur.fetchall()
    except Exception:
        logger.exception("get_chunks_by_item failed for item_id=%s", item_id)
        return []

    chunks = []
    for i, row in enumerate(rows):
        meta = row["metadata"] if isinstance(row["metadata"], dict) else {}
        chunks.append({
            "index": meta.get("chunk_index", i),
            "text": row["content"],
        })
    return chunks
