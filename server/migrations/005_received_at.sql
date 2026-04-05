-- Migration 005: Server-side received_at timestamp for temporal integrity
-- Provides an independent server timestamp for each entry received during sync.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill: use synced_at as best available approximation for existing entries
UPDATE ledger_entries
SET received_at = synced_at
WHERE received_at IS NULL AND synced_at IS NOT NULL;
