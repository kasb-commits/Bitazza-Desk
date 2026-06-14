-- Migration 015: pgvector embedding store
-- Replaces ChromaDB with PostgreSQL-native vector storage.
-- pgvector is pre-installed on Railway Postgres 15+.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_embeddings (
    id          BIGSERIAL    PRIMARY KEY,
    external_id TEXT         NOT NULL,
    collection  TEXT         NOT NULL DEFAULT 'knowledge_base',
    content     TEXT         NOT NULL,
    embedding   vector(3072),
    doc_type    TEXT,                        -- promoted column for fast pre-filter
    metadata    JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_vector_embeddings_coll_ext UNIQUE (collection, external_id)
);

-- Note: pgvector HNSW/IVFFlat indexes cap at 2000 dimensions.
-- Gemini text-embedding-001 is 3072-dim, so no ANN index is possible.
-- At KB sizes < 100k rows, exact cosine scan is fast enough (~10-50ms).
-- If the KB grows beyond that, consider dimension reduction or halfvec.

-- B-tree index for collection + doc_type pre-filter
CREATE INDEX IF NOT EXISTS idx_vector_embeddings_coll_doctype
    ON vector_embeddings (collection, doc_type);
