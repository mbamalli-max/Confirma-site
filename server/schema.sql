CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE,
  phone_share_group UUID,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- M2 migration 024, phone-number rule section (G1/G1a). This is the reviewed
-- rule text from migrations/024_phone_change.sql, without that file's wrapper
-- transaction because schema.sql is the fresh-install transaction.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_share_group UUID;

CREATE OR REPLACE FUNCTION users_phone_rule_key(account_id UUID, share_group UUID)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN share_group IS NULL THEN 'account:' || account_id::text
              ELSE 'share:' || share_group::text END
$$;

DO $$
DECLARE
  groups_n INT;
  largest_n INT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_digits_excl') THEN
    RETURN; -- already applied
  END IF;
  SELECT count(*), coalesce(max(c), 0) INTO groups_n, largest_n
  FROM (SELECT count(*) AS c FROM users WHERE phone_number IS NOT NULL
        GROUP BY regexp_replace(phone_number, '[^0-9]', '', 'g') HAVING count(*) > 1) g;
  IF NOT (groups_n = 0 OR (groups_n = 1 AND largest_n = 2)) THEN
    RAISE EXCEPTION 'phone digit collisions outside the reviewed state: groups=%, largest=%', groups_n, largest_n;
  END IF;
  UPDATE users u SET phone_share_group = s.grp
  FROM (SELECT x.d, gen_random_uuid() AS grp
        FROM (SELECT regexp_replace(phone_number, '[^0-9]', '', 'g') AS d FROM users
              WHERE phone_number IS NOT NULL GROUP BY 1 HAVING count(*) = 2) x) s
  WHERE u.phone_number IS NOT NULL AND regexp_replace(u.phone_number, '[^0-9]', '', 'g') = s.d;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_digits_excl') THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_digits_excl EXCLUDE USING gist (
      (regexp_replace(phone_number, '[^0-9]', '', 'g')) WITH =,
      (users_phone_rule_key(id, phone_share_group)) WITH <>
    ) WHERE (phone_number IS NOT NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION users_phone_share_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.phone_share_group := NULL;
    RETURN NEW;
  END IF;
  IF NEW.phone_share_group IS NOT NULL AND NEW.phone_share_group IS DISTINCT FROM OLD.phone_share_group THEN
    RAISE EXCEPTION 'phone_share_group is set only by migration 024' USING ERRCODE = '23514';
  END IF;
  IF NEW.phone_number IS DISTINCT FROM OLD.phone_number THEN
    NEW.phone_share_group := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_phone_share_group_guard ON users;
CREATE TRIGGER users_phone_share_group_guard BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_phone_share_group_guard();

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

CREATE TABLE IF NOT EXISTS phone_change_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  new_phone_number TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_change_challenges_user_created
  ON phone_change_challenges (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS phone_change_failed_guesses (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  challenge_id UUID REFERENCES phone_change_challenges(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_change_failed_guesses_user_created
  ON phone_change_failed_guesses (user_id, created_at);
CREATE TABLE IF NOT EXISTS account_phone_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_identity TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notice_sent BOOLEAN NOT NULL DEFAULT FALSE
);

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
