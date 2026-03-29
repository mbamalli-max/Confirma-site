CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  phone_number TEXT PRIMARY KEY,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id_unique
  ON users(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users ((LOWER(email)))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_identities (
  device_identity TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  phone_number TEXT NOT NULL REFERENCES users(phone_number),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  rotated_to TEXT,
  receipt_counter BIGINT NOT NULL DEFAULT 0,
  last_synced_entry_id BIGINT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
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
  phone_number TEXT,
  identifier TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created_at
  ON otp_challenges (phone_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_identifier_created_at
  ON otp_challenges (identifier, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_device_synced
  ON ledger_entries (device_identity, synced_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  business_name TEXT,
  country CHAR(2),
  business_type_id TEXT,
  sector_id TEXT,
  preferred_labels JSONB DEFAULT '[]'::jsonb,
  -- Retained for backward compatibility only. Passcode hints are local-only and are no longer synced.
  passcode_hint TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attestations (
  vt_id            TEXT PRIMARY KEY,
  device_identity  TEXT NOT NU