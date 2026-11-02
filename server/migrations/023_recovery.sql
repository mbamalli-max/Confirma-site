-- Package C recovery holding area and durable reconciliation evidence. Additive only:
-- nothing here changes ledger_entries, ledger_integrity_events, device identities,
-- or any metrics/admin table. Deleting the live copy does not immediately remove
-- provider backups (daily 6 days, weekly 1 month, monthly 3 months, PITR about 4 weeks).
BEGIN;

CREATE TABLE IF NOT EXISTS recovery_sessions (
  recovery_id UUID PRIMARY KEY,
  device_identity TEXT NOT NULL REFERENCES device_identities(device_identity),
  user_id UUID NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'uploaded', 'planned', 'syncing', 'completed', 'superseded', 'escalated')),
  app_version TEXT NOT NULL,
  local_summary JSONB NOT NULL,
  integrity_hwm BIGINT NOT NULL DEFAULT 0,
  declared_part_count INTEGER CHECK (declared_part_count IS NULL OR declared_part_count > 0),
  declared_part_hashes JSONB,
  received_bound_seconds BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT,
  manifest_hash TEXT,
  manifest JSONB,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('cleared', 'not_cleared')),
  outcome_reasons JSONB,
  reconciliation_result JSONB,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Keep this migration repeatable for local databases created by an earlier C2
-- candidate before the preservation declaration was added.
ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS declared_part_count INTEGER
    CHECK (declared_part_count IS NULL OR declared_part_count > 0);
ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS declared_part_hashes JSONB;
ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS received_bound_seconds BIGINT
    NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_sessions_one_active_device
  ON recovery_sessions (device_identity)
  WHERE state IN ('open', 'uploaded', 'planned', 'syncing');

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_completed
  ON recovery_sessions (completed_at)
  WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS recovery_parts (
  recovery_id UUID NOT NULL REFERENCES recovery_sessions(recovery_id),
  part_no INTEGER NOT NULL CHECK (part_no >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recovery_id, part_no)
);

CREATE TABLE IF NOT EXISTS recovery_reservations (
  device_identity TEXT NOT NULL REFERENCES device_identities(device_identity),
  original_entry_hash TEXT NOT NULL,
  original_local_id BIGINT NOT NULL,
  original_signed_id BIGINT NOT NULL,
  planned_entry_id BIGINT NOT NULL,
  planned_entry_hash TEXT NOT NULL,
  recovery_id UUID NOT NULL REFERENCES recovery_sessions(recovery_id),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'accepted', 'released')),
  date_check TEXT NOT NULL CHECK (date_check IN ('ok', 'before_2000', 'future', 'after_receipt_bound')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  UNIQUE (device_identity, original_entry_hash),
  UNIQUE (device_identity, planned_entry_id),
  UNIQUE (device_identity, planned_entry_hash)
);

CREATE INDEX IF NOT EXISTS idx_recovery_reservations_session_status
  ON recovery_reservations (recovery_id, status);

CREATE TABLE IF NOT EXISTS ledger_recoveries (
  device_identity TEXT NOT NULL REFERENCES device_identities(device_identity),
  original_entry_hash TEXT NOT NULL,
  original_local_id BIGINT NOT NULL,
  original_signed_id BIGINT NOT NULL,
  original_confirmed_at JSONB NOT NULL,
  date_check TEXT NOT NULL CHECK (date_check IN ('ok', 'before_2000', 'future', 'after_receipt_bound')),
  replacement_entry_id BIGINT NOT NULL,
  replacement_entry_hash TEXT NOT NULL,
  recovery_id UUID NOT NULL REFERENCES recovery_sessions(recovery_id),
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_identity, original_entry_hash)
);

CREATE INDEX IF NOT EXISTS idx_ledger_recoveries_recovery
  ON ledger_recoveries (recovery_id);

-- Keep local candidate databases created by an earlier uncommitted version of
-- this migration usable. Historical C2 rows predate the raw/signed distinction,
-- so their signed id is the then-single original_local_id.
ALTER TABLE recovery_reservations
  ADD COLUMN IF NOT EXISTS original_signed_id BIGINT;
UPDATE recovery_reservations
SET original_signed_id = original_local_id
WHERE original_signed_id IS NULL;
ALTER TABLE recovery_reservations
  ALTER COLUMN original_signed_id SET NOT NULL;

ALTER TABLE ledger_recoveries
  ADD COLUMN IF NOT EXISTS original_signed_id BIGINT;
UPDATE ledger_recoveries
SET original_signed_id = original_local_id
WHERE original_signed_id IS NULL;
ALTER TABLE ledger_recoveries
  ALTER COLUMN original_signed_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS recovery_audit_events (
  id BIGSERIAL PRIMARY KEY,
  device_identity TEXT NOT NULL,
  recovery_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'recovery_started',
    'recovery_planned',
    'recovery_completed_cleared',
    'recovery_completed_not_cleared',
    'recovery_unresolved',
    'recovery_lease_superseded'
  )),
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_audit_events_device_created
  ON recovery_audit_events (device_identity, created_at DESC);

COMMIT;
