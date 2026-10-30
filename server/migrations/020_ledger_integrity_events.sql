-- T4: durable record of rejected sync submissions (a conflicting submission for a
-- device's chain, or record fields that don't match their signed hash). Rows are
-- written after the rejected batch rolls back, so they survive it. Additive only.
BEGIN;

CREATE TABLE IF NOT EXISTS ledger_integrity_events (
  id BIGSERIAL PRIMARY KEY,
  device_identity TEXT NOT NULL,
  entry_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('fork_continuity', 'fork_id_conflict', 'hash_mismatch')),
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_integrity_events_device_kind
  ON ledger_integrity_events (device_identity, kind, created_at DESC);

COMMIT;
