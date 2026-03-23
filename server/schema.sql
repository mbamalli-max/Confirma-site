CREATE TABLE IF NOT EXISTS users (
  phone_number TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_identities (
  device_identity TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  phone_number TEXT NOT NULL REFERENCES users(phone_number),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  rotated_to TEXT,
  receipt_counter BIGINT NOT NULL DEFAULT 0,
  last_synced_entry_id BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  device_identity TEXT NOT NULL REFERENCES device_identities(device_identity),
  entry_id BIGINT NOT NULL,
  entry_hash TEXT NOT NULL,
  prev_entry_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_key_fingerprint TEXT,
  payload JSONB NOT NULL,
  PRIMARY KEY (device_identity, entry_id)
);

CREATE TABLE IF NOT EXISTS key_rotation_events (
  id BIGSERIAL PRIMARY KEY,
  old_device_identity TEXT NOT NULL,
  new_device_identity TEXT NOT NULL,
  phone_number TEXT NOT NULL REFERENCES users(phone_number),
  otp_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotation_receipt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created_at
  ON otp_challenges (phone_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_device_synced
  ON ledger_entries (device_identity, synced_at DESC);
