-- Migration 015: pgvector knowledge embeddings table
-- Replaces ChromaDB with PostgreSQL + pgvector for vector similarity search.
-- Safe to run multiple times (idempotent).
-- Note: 3072-dim vectors (Gemini) exceed pgvector's 2000-dim index limit,
--       so vector similarity uses sequential scan. Fast enough for KB sizes.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_embeddings (
    id          BIGSERIAL PRIMARY KEY,
    external_id TEXT        NOT NULL,
    collection  TEXT        NOT NULL DEFAULT 'knowledge_base',
    content     TEXT        NOT NULL,
    embedding   vector(3072),
    doc_type    TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (collection, external_id)
);

CREATE INDEX IF NOT EXISTS vector_embeddings_collection_idx
    ON vector_embeddings (collection);

CREATE INDEX IF NOT EXISTS vector_embeddings_doc_type_idx
    ON vector_embeddings (doc_type);
