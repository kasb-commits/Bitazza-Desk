#!/bin/bash
set -e

# Auto-ingest KB articles into ChromaDB on every boot.
# Uses a checksum file to track which articles are already ingested —
# only re-ingests when kb_articles/ content has changed since last run.

CHECKSUM_FILE="/data/chroma/.kb_checksum"
CURRENT_CHECKSUM=$(find kb_articles/ -name "*.md" -exec md5sum {} \; 2>/dev/null | sort | md5sum | awk '{print $1}')

echo "Checking KB state..."

if [ -f "$CHECKSUM_FILE" ] && [ "$(cat $CHECKSUM_FILE)" = "$CURRENT_CHECKSUM" ]; then
    echo "KB articles unchanged since last ingestion — skipping."
else
    echo "KB articles changed (or first boot) — running ingestion..."
    PYTHONPATH=. python3 ingestion/docs_ingester.py --dir kb_articles/ && echo "KB articles ingested."
    PYTHONPATH=. python3 ingestion/blog_ingester.py && echo "Blog posts ingested."
    echo "$CURRENT_CHECKSUM" > "$CHECKSUM_FILE"
    echo "Checksum saved."
fi

echo "Starting API server..."
exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8080}
