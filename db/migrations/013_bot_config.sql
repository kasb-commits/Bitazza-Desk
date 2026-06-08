-- Migration 013: bot_config key-value store
-- Used to persist admin-controlled feature flags (e.g. quick-reply pill settings).

CREATE TABLE IF NOT EXISTS bot_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
