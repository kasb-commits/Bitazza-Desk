"""
Vector store abstraction over ChromaDB.

Embedding model: Gemini text-embedding-001 (3072-dim, semantic).
Falls back to word-hash embedding if GEMINI_API_KEY is unavailable.

Gemini cosine distances: <0.35 = strong match, <0.55 = relevant.
"""
try:
    import chromadb
    from chromadb import EmbeddingFunction, Documents, Embeddings
    _CHROMA_AVAILABLE = True
except ImportError:
    _CHROMA_AVAILABLE = False

import hashlib, logging, math, re, os, time

logger = logging.getLogger(__name__)
from config.settings import CHROMA_PATH

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
    """Call Gemini embedding API for a batch of texts. Returns None on failure."""
    client = _get_gemini_client()
    if client is None:
        return None
    try:
        result = client.models.embed_content(
            model=_EMBED_MODEL,
            contents=texts,
        )
        return [e.values for e in result.embeddings]
    except Exception as exc:
        logger.warning("Gemini embed_content failed: %s — falling back to word-hash", exc)
        return None


# ── Word-hash fallback embedding (unchanged) ──────────────────────────────────

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


# ── ChromaDB embedding function ───────────────────────────────────────────────

if _CHROMA_AVAILABLE:
    class _GeminiEmbedFn(EmbeddingFunction):
        """
        Calls Gemini embedding API in batches.
        Falls back to word-hash per-document if the API is unavailable.
        """
        def __call__(self, input: Documents) -> Embeddings:
            results: list[list[float]] = [[] for _ in input]
            # Process in batches
            for start in range(0, len(input), _EMBED_BATCH):
                batch = list(input[start:start + _EMBED_BATCH])
                vecs = _gemini_embed_batch(batch)
                if vecs is not None:
                    for i, vec in enumerate(vecs):
                        results[start + i] = list(vec)
                else:
                    # Fallback: word-hash for each doc in failed batch
                    for i, doc in enumerate(batch):
                        results[start + i] = _word_embed(doc)
                # Small delay to stay within RPM quota when processing many docs
                if start + _EMBED_BATCH < len(input):
                    time.sleep(0.05)
            return results

    _embed_fn = _GeminiEmbedFn()
else:
    _embed_fn = None

_client = None


# ── ChromaDB client & collection ──────────────────────────────────────────────

def get_client():
    global _client
    if not _CHROMA_AVAILABLE:
        raise RuntimeError("chromadb not installed. Run: pip install chromadb")
    if _client is None:
        path = os.environ.get("CHROMA_PATH") or CHROMA_PATH
        _client = chromadb.PersistentClient(path=path)
    return _client


def get_collection(name: str = "knowledge_base"):
    return get_client().get_or_create_collection(
        name=name,
        embedding_function=_embed_fn,
        metadata={"hnsw:space": "cosine"},
    )


# ── Public API ────────────────────────────────────────────────────────────────

def upsert_documents(docs: list[dict], collection_name: str = "knowledge_base") -> None:
    """docs: list of {id, text, metadata}"""
    col = get_collection(collection_name)
    metadatas = [d.get("metadata") or {"_": "1"} for d in docs]
    col.upsert(
        ids=[d["id"] for d in docs],
        documents=[d["text"] for d in docs],
        metadatas=metadatas,
    )


def query(text: str, n_results: int = 5, collection_name: str = "knowledge_base",
          where: dict | None = None) -> list[dict]:
    """Returns top-n chunks with text and metadata. Optionally filter by metadata via ChromaDB where clause."""
    col = get_collection(collection_name)
    query_kwargs: dict = {"query_texts": [text], "n_results": n_results}
    if where:
        query_kwargs["where"] = where
    results = col.query(**query_kwargs)
    chunks = []
    for i, doc in enumerate(results["documents"][0]):
        chunks.append({
            "text": doc,
            "metadata": results["metadatas"][0][i],
            "distance": results["distances"][0][i] if results.get("distances") else None,
        })
    return chunks


def delete_by_metadata(filter_key: str, filter_value: str, collection_name: str = "knowledge_base") -> int:
    """Delete all chunks whose metadata[filter_key] == filter_value. Returns count deleted."""
    if not _CHROMA_AVAILABLE:
        return 0
    try:
        col = get_collection(collection_name)
        results = col.get(where={filter_key: {"$eq": filter_value}})
        ids = results.get("ids") or []
        if ids:
            col.delete(ids=ids)
        return len(ids)
    except Exception:
        logger.exception("Failed to delete_by_metadata %s=%s", filter_key, filter_value)
        return 0


def collection_count(collection_name: str = "knowledge_base") -> int:
    if not _CHROMA_AVAILABLE:
        return 0
    try:
        return get_collection(collection_name).count()
    except Exception:
        logger.exception("Failed to count collection '%s' — returning 0", collection_name)
        return 0
