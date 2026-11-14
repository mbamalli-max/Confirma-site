BEGIN;

-- M2 migration 024, phone-number rule section (G1/G1a). The builder copies this block VERBATIM into
-- server/migrations/024_phone_change.sql (inside the migration's single transaction) and schema.sql.
-- Rule: two accounts may hold numbers with the same digits only if both carry the same SHARE group,
-- which only this migration sets, only on the one pre-existing pair, and which is cleared for an
-- account the moment its number changes. Ordinary accounts are keyed 'account:<id>' and shared
-- accounts 'share:<group>', so an account whose share group is cleared can never collide-match the
-- group it left (owner review 2026-11-09: the earlier min(id) tag let that account reclaim the digits).
-- Prints and stores no phone numbers, digits or ids beyond the new column on the pair.

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
  -- One fresh random group id for the single reviewed pair (never an account id).
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

COMMIT;
