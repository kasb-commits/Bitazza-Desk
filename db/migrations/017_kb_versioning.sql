-- Migration 017: KB document versioning
-- Adds status, version chain, and audit columns to knowledge_items.
-- Existing rows default to status='ACTIVE', version_number=1.

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS status         TEXT    NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'ARCHIVED', 'PROCESSING', 'FAILED')),
  ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_id      INTEGER REFERENCES knowledge_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by  INTEGER REFERENCES knowledge_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS change_notes   TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ;

-- Safety net: enforce exactly one ACTIVE version per document family.
-- Family root = COALESCE(parent_id, id): all versions store the v1 id as parent_id.
-- Partial index covers only ACTIVE rows; ARCHIVED/PROCESSING/FAILED are exempt.
-- Operation order in activate_knowledge_version MUST be: ARCHIVE old first, then ACTIVE new,
-- so the old index entry is removed before the new one is inserted.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_one_active_per_root
  ON knowledge_items (COALESCE(parent_id, id))
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS knowledge_items_status_idx  ON knowledge_items (status);
CREATE INDEX IF NOT EXISTS knowledge_items_parent_idx  ON knowledge_items (parent_id);
