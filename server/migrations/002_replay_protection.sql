-- Pre-check: duplicates must not exist before index creation
-- If this migration fails, manually resolve duplicates first:
-- SELECT entry_hash, COUNT(*) FROM ledger_entries GROUP BY entry_hash HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_entry_hash_unique
  ON ledger_entries (entry_hash);
