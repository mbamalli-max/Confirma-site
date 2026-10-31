CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE,
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
  phone_number TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
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

CREATE INDEX IF NOT EXISTS idx_device_identities_user_id ON device_identities (user_id);

CREATE TABLE IF NOT EXISTS key_rotation_events (
  id BIGSERIAL PRIMARY KEY,
  old_device_identity TEXT NOT NULL,
  new_device_identity TEXT NOT NULL,
  phone_number TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
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
  verified_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created_at
  ON otp_challenges (phone_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_identifier_created_at
  ON otp_challenges (identifier, channel, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_verify_failures (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  channel TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_verify_failures_identifier_channel_failed_at
  ON otp_verify_failures (identifier, channel, failed_at);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_device_synced
  ON ledger_entries (device_identity, synced_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  business_name TEXT,
  country CHAR(2),
  business_type_id TEXT,
  sector_id TEXT,
  -- How the sector was set: catalog, user, rule or fallback (migration 017 adds the guards).
  sector_source TEXT,
  preferred_labels JSONB DEFAULT '[]'::jsonb,
  -- Retained for backward compatibility only. Passcode hints are local-only and are no longer synced.
  passcode_hint TEXT,
  phone_number TEXT,
  plan TEXT,
  plan_activated_at TIMESTAMPTZ,
  -- Set only when business_type_id = 'unlisted' (migration 015).
  business_description TEXT
    CONSTRAINT profiles_business_description_length
    CHECK (business_description IS NULL OR char_length(business_description) BETWEEN 3 AND 60),
  -- Server-only; written by future admin tooling, never from the client.
  classification_review TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT profiles_unlisted_description_pairing
    CHECK ((COALESCE(business_type_id, '') = 'unlisted') = (business_description IS NOT NULL))
);

-- Rejected sync submissions (T4, migration 020): conflicting chain submissions
-- and hash mismatches, written after the rejected batch rolls back.
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

CREATE TABLE IF NOT EXISTS attestations (
  vt_id            TEXT PRIMARY KEY,
  device_identity  TEXT NOT NULL REFERENCES device_identities(device_identity),
  phone_number     TEXT,
  user_id          UUID NOT NULL REFERENCES users(id),
  ledger_root_hash TEXT NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  entry_count      INTEGER NOT NULL,
  server_signature TEXT NOT NULL,
  signing_kid      TEXT,
  status           TEXT NOT NULL DEFAULT 'VALID',
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attestations_device
  ON attestations (device_identity, issued_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
  device_identity TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL,
  tier TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  paystack_status TEXT NOT NULL DEFAULT 'pending',
  vt_id TEXT REFERENCES attestations(vt_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_key_rotation_events_user_id ON key_rotation_events (user_id);
CREATE INDEX IF NOT EXISTS idx_attestations_user_id ON attestations (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);

CREATE INDEX IF NOT EXISTS idx_payments_phone
  ON payments (phone_number, created_at DESC);
