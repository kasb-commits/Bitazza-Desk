-- Migration 013: add region column to tickets
-- Region is extracted from the Bitazza JWT claim and stored at conversation creation.
-- NULL for existing rows and for sessions where the JWT does not yet include the claim.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS region TEXT;
