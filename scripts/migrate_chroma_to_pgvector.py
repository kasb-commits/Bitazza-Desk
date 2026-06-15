"""
One-off migration: ChromaDB → pgvector

Reads every document from the ChromaDB 'knowledge_base' collection and
upserts it into vector_embeddings (pgvector) via the existing pipeline.

Run from the project root:
    python scripts/migrate_chroma_to_pgvector.py [--dry-run]

On Railway (if a volume is mounted):
    railway run python scripts/migrate_chroma_to_pgvector.py
"""
import argparse
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── CLI args ──────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--dry-run", action="store_true", help="Print what would be migrated without writing")
parser.add_argument("--batch", type=int, default=20, help="Upsert batch size (default 20)")
args = parser.parse_args()

# ── ChromaDB ──────────────────────────────────────────────────────────────────

try:
    import chromadb
except ImportError:
    logger.error("chromadb not installed. Run: pip install chromadb")
    sys.exit(1)

from config.settings import CHROMA_PATH

if not CHROMA_PATH or not os.path.isdir(CHROMA_PATH):
    logger.error("CHROMA_PATH=%r does not exist or is not a directory — no ChromaDB data found", CHROMA_PATH)
    sys.exit(1)

logger.info("Opening ChromaDB at %s", CHROMA_PATH)
chroma = chromadb.PersistentClient(path=CHROMA_PATH)

try:
    col = chroma.get_collection("knowledge_base")
except Exception as exc:
    logger.error("Could not open 'knowledge_base' collection: %s", exc)
    sys.exit(1)

total_chroma = col.count()
logger.info("ChromaDB 'knowledge_base' has %d documents", total_chroma)

if total_chroma == 0:
    logger.info("Nothing to migrate.")
    sys.exit(0)

# ── Fetch all docs from ChromaDB ──────────────────────────────────────────────
# ChromaDB returns at most 'limit' at a time; page through with offset.

PAGE = 500
all_docs: list[dict] = []
offset = 0

while True:
    result = col.get(limit=PAGE, offset=offset, include=["documents", "metadatas"])
    ids       = result.get("ids", [])
    documents = result.get("documents", [])
    metadatas = result.get("metadatas", [])

    if not ids:
        break

    for chroma_id, text, meta in zip(ids, documents, metadatas):
        if not text or not text.strip():
            logger.warning("Skipping empty doc id=%s", chroma_id)
            continue
        all_docs.append({"id": chroma_id, "text": text, "metadata": meta or {}})

    offset += len(ids)
    logger.info("  fetched %d / %d from ChromaDB", offset, total_chroma)
    if len(ids) < PAGE:
        break

logger.info("Total non-empty documents to migrate: %d", len(all_docs))

if args.dry_run:
    logger.info("--dry-run: first 3 docs:")
    for d in all_docs[:3]:
        logger.info("  id=%s meta=%s text[:80]=%r", d["id"], d["meta"], d["text"][:80])
    sys.exit(0)

# ── Upsert into pgvector ───────────────────────────────────────────────────────

from db.vector_store import upsert_documents

batch_size = args.batch
success = 0
failed  = 0

for start in range(0, len(all_docs), batch_size):
    batch = all_docs[start : start + batch_size]
    try:
        upsert_documents(batch)
        success += len(batch)
        logger.info("  upserted %d / %d", start + len(batch), len(all_docs))
    except Exception as exc:
        logger.error("  batch %d–%d failed: %s", start, start + len(batch), exc)
        failed += len(batch)

logger.info("Migration complete — %d upserted, %d failed", success, failed)

if failed:
    sys.exit(1)
