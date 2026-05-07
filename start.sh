#!/bin/bash
set -e

# Auto-ingest KB articles into ChromaDB on first boot (or after volume reset)
# Checks if the collection is empty before running to avoid duplicate ingestion
echo "Checking ChromaDB state..."
CHUNK_COUNT=$(PYTHONPATH=. python3 -c "
try:
    from db.vector_store import collection_count
    print(collection_count())
except Exception as e:
    print(0)
" 2>/dev/null || echo 0)

echo "ChromaDB has $CHUNK_COUNT chunks"

if [ "$CHUNK_COUNT" -lt 10 ]; then
    echo "Collection is empty — running KB ingestion..."
    PYTHONPATH=. python3 ingestion/docs_ingester.py --dir kb_articles/ && echo "KB articles ingested."
    PYTHONPATH=. python3 ingestion/blog_ingester.py && echo "Blog posts ingested."
else
    echo "Collection already populated — skipping ingestion."
fi

echo "Starting API server..."
exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8080}
