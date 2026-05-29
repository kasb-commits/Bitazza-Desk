-- Migration 011: Add error_source column to tickets
-- Used by POST /chat/emergency-escalate to record why a ticket was
-- created without a normal bot session (e.g. start_failed).

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS error_source TEXT;
