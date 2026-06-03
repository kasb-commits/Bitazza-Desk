"""
Ingest classified Freshdesk tickets into the vector knowledge base.
Strips PII before ingestion. Skips spam/unclear categories.
Usage: python ingestion/freshdesk_ingester.py
"""
import json, re
from pathlib import Path
from db.vector_store import upsert_documents, collection_count

SKIP_CATEGORIES = {"spam", "other"}
INPUT = Path("data/classified_tickets.json")


def strip_pii(text: str) -> str:
    text = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "[EMAIL]", text)
    text = re.sub(r"\b\d{10,13}\b", "[PHONE_OR_ID]", text)
    return text


def main():
    if not INPUT.exists():
        print(f"ERROR: {INPUT} not found. Run classify_tickets.py first.")
        return

    tickets = json.loads(INPUT.read_text())
    docs = []
    skipped = 0
    seen_ids: set = set()

    for t in tickets:
        if t.get("category") in SKIP_CATEGORIES:
            skipped += 1
            continue

        # Deduplicate by ticket ID (split tickets share the same ID)
        doc_id = f"fd_{t['id']}"
        if doc_id in seen_ids:
            skipped += 1
            continue
        seen_ids.add(doc_id)

        subject = strip_pii(t.get("subject", ""))
        body = strip_pii(t.get("description", "") or t.get("body", "") or t.get("description_text", ""))
        resolution = strip_pii(t.get("resolution", "") or t.get("resolution_note", ""))

        parts = [f"Category: {t.get('category','')} | Subcategory: {t.get('subcategory','')}"]
        parts.append(f"Question: {subject}")
        if body:
            parts.append(f"Details: {body[:1000]}")
        if resolution:
            parts.append(f"Resolution: {resolution[:500]}")
        text = "\n".join(parts)

        docs.append({
            "id": doc_id,
            "text": text,
            "metadata": {
                "source": "freshdesk",
                "doc_type": "ticket",
                "category": t.get("category", ""),
                "language": t.get("language", ""),
                "resolution_type": t.get("resolution_type", ""),
            },
        })

    print(f"Ingesting {len(docs)} tickets (skipped {skipped} spam/other)...")
    # Batch upsert in chunks of 500
    for i in range(0, len(docs), 500):
        upsert_documents(docs[i:i+500])
        print(f"  {min(i+500, len(docs))}/{len(docs)}...", flush=True)

    print(f"Done. Vector DB now has {collection_count()} documents.")


if __name__ == "__main__":
    main()
