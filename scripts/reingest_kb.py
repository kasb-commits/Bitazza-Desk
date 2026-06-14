"""
Re-ingest all knowledge_items from PostgreSQL into pgvector.

Runs after the 015_pgvector.sql migration is applied. Reads every row in
knowledge_items, re-fetches URL sources, re-chunks, and upserts into
vector_embeddings. File-based items (PDF/DOCX) cannot be re-fetched
automatically and must be re-uploaded via the dashboard.

Usage:
    python scripts/reingest_kb.py
    python scripts/reingest_kb.py --item-id 5   # re-ingest a single item

Prerequisites:
    DATABASE_URL and GEMINI_API_KEY set in environment / .env
    015_pgvector.sql migration already applied
"""
import argparse
import logging
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests as _requests
from bs4 import BeautifulSoup

# Import chunking logic from knowledge route (single source of truth)
from api.routes.knowledge import _chunk_text
from db.vector_store import upsert_documents
from db.conversation_store import _conn

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)


def _fetch_url(url: str) -> tuple[str, str]:
    """Fetch a URL and return (title, body_text). Raises on failure."""
    resp = _requests.get(url, timeout=20, headers={"User-Agent": "CSBot-Reingest/1.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup.find_all(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    title_tag = soup.find("title") or soup.find("h1")
    title = title_tag.get_text(strip=True) if title_tag else url
    body = soup.get_text(separator="\n", strip=True)
    return title, body


def reingest_item(item: dict) -> bool:
    """Re-ingest a single knowledge_items row. Returns True on success."""
    item_id = item["id"]
    title = item["title"]
    source_type = item["source_type"]
    source_ref = item["source_ref"]

    # Check if source_ref is a local file path that exists (e.g. kb_articles/*.md)
    _root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _local_path = os.path.join(_root, source_ref) if source_ref else None
    _is_local_file = _local_path and os.path.isfile(_local_path)

    if _is_local_file:
        try:
            with open(_local_path, "r", encoding="utf-8") as f:
                body = f.read()
        except Exception as exc:
            logger.error("  FAIL item %d (%s) — could not read %s: %s", item_id, title, _local_path, exc)
            return False

        chunks = _chunk_text(body)
        if not chunks:
            logger.warning("  SKIP item %d (%s) — no text extracted from file", item_id, title)
            return False

        docs = [
            {
                "id": f"kb_{item_id}_{i}",
                "text": chunk,
                "metadata": {
                    "knowledge_item_id": str(item_id),
                    "source": source_ref,
                    "source_type": source_type,
                    "title": title[:255],
                    "chunk_index": i,
                },
            }
            for i, chunk in enumerate(chunks)
        ]
        upsert_documents(docs)

        with _conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE knowledge_items SET chunk_count = %s WHERE id = %s",
                (len(chunks), item_id),
            )

        logger.info("  OK   item %d (%s) — %d chunks ingested (local file)", item_id, title, len(chunks))
        return True

    elif source_type == "url":
        if not source_ref:
            logger.warning("  SKIP item %d (%s) — no source_ref URL stored", item_id, title)
            return False
        try:
            fetched_title, body = _fetch_url(source_ref)
        except Exception as exc:
            logger.error("  FAIL item %d (%s) — could not fetch %s: %s", item_id, title, source_ref, exc)
            return False

        chunks = _chunk_text(body)
        if not chunks:
            logger.warning("  SKIP item %d (%s) — no text extracted from URL", item_id, title)
            return False

        docs = [
            {
                "id": f"kb_{item_id}_{i}",
                "text": chunk,
                "metadata": {
                    "knowledge_item_id": str(item_id),
                    "source": source_ref,
                    "source_type": "url",
                    "title": (fetched_title or title)[:255],
                    "chunk_index": i,
                },
            }
            for i, chunk in enumerate(chunks)
        ]
        upsert_documents(docs)

        # Update chunk_count in knowledge_items
        with _conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE knowledge_items SET chunk_count = %s WHERE id = %s",
                (len(chunks), item_id),
            )

        logger.info("  OK   item %d (%s) — %d chunks ingested", item_id, title, len(chunks))
        return True

    else:
        # PDF / DOCX — cannot be re-fetched programmatically
        logger.warning(
            "  MANUAL item %d (%s) — source_type='%s', file='%s'. "
            "Re-upload via dashboard → Knowledge Base.",
            item_id, title, source_type, source_ref or "(unknown)",
        )
        return False


def main():
    parser = argparse.ArgumentParser(description="Re-ingest knowledge_items into pgvector")
    parser.add_argument("--item-id", type=int, default=None, help="Re-ingest a single item by ID")
    args = parser.parse_args()

    with _conn() as conn:
        cur = conn.cursor()
        if args.item_id:
            cur.execute(
                "SELECT id, title, source_type, source_ref FROM knowledge_items WHERE id = %s",
                (args.item_id,),
            )
        else:
            cur.execute(
                "SELECT id, title, source_type, source_ref FROM knowledge_items ORDER BY id"
            )
        items = cur.fetchall()

    if not items:
        logger.info("No knowledge_items found.")
        return

    logger.info("Re-ingesting %d knowledge item(s)…", len(items))
    ok = failed = manual = 0
    for item in items:
        result = reingest_item(dict(item))
        if result:
            ok += 1
        elif item["source_type"] == "url":
            failed += 1
        else:
            manual += 1

    logger.info(
        "\nDone. %d ingested, %d failed (URL fetch error), %d need manual re-upload.",
        ok, failed, manual,
    )


if __name__ == "__main__":
    main()
