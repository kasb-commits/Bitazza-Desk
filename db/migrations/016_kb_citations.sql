-- Migration 016: KB citation metadata columns
-- Adds AI-generated (and agent-editable) citation classification to knowledge_items.
-- All columns are nullable/defaulted so existing rows are unaffected.

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS citation_categories      TEXT[]    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS citation_keywords        TEXT[]    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coverage_score           NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS citations_generated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS citations_source         TEXT      NOT NULL DEFAULT 'pending'
                             CHECK (citations_source IN ('pending', 'ai', 'manual')),
  ADD COLUMN IF NOT EXISTS citations_edited_by      UUID      REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS citations_edited_at      TIMESTAMPTZ;

-- GIN index for fast array containment queries (category filtering)
CREATE INDEX IF NOT EXISTS knowledge_items_categories_gin
  ON knowledge_items USING GIN (citation_categories);
