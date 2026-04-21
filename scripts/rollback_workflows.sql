-- ROLLBACK: unpublish workflows back to pre-fix state (2026-04-20)
-- Run against local or Railway DB to undo the publish changes.
-- Only affects the two workflows that were changed; KYC was already published.
BEGIN;

-- Undo: Account Restriction was published=FALSE before the fix
UPDATE workflows SET published = FALSE
  WHERE trigger_category = 'account_restriction';

-- Undo: Withdrawal Issue was published=FALSE before the fix
UPDATE workflows SET published = FALSE
  WHERE trigger_category = 'withdrawal_issue';

COMMIT;
