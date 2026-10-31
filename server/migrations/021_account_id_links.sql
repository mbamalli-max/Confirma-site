-- M1a: retain the phone primary key while adding the permanent account link.
-- This migration runs in migrate.js's transaction.
ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE key_rotation_events ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE attestations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE rotation_challenges ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- Do not guess at bad historic ownership.  The transaction must stop intact so
-- the rows can be diagnosed before this release is retried.
DO $$
DECLARE missing_count bigint;
BEGIN
  SELECT COUNT(*) INTO missing_count FROM (
    SELECT d.phone_number FROM device_identities d LEFT JOIN users u ON u.phone_number = d.phone_number WHERE u.id IS NULL
    UNION ALL SELECT k.phone_number FROM key_rotation_events k LEFT JOIN users u ON u.phone_number = k.phone_number WHERE u.id IS NULL
    UNION ALL SELECT a.phone_number FROM attestations a LEFT JOIN users u ON u.phone_number = a.phone_number WHERE u.id IS NULL
    UNION ALL SELECT p.phone_number FROM payments p LEFT JOIN users u ON u.phone_number = p.phone_number WHERE u.id IS NULL
    UNION ALL SELECT r.phone_number FROM rotation_challenges r LEFT JOIN users u ON u.phone_number = r.phone_number WHERE u.id IS NULL
  ) unresolved;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'account-id migration found % rows with an unresolvable phone owner', missing_count;
  END IF;
END $$;

UPDATE device_identities d SET user_id = u.id FROM users u WHERE u.phone_number = d.phone_number AND d.user_id IS NULL;
UPDATE key_rotation_events k SET user_id = u.id FROM users u WHERE u.phone_number = k.phone_number AND k.user_id IS NULL;
UPDATE attestations a SET user_id = u.id FROM users u WHERE u.phone_number = a.phone_number AND a.user_id IS NULL;
UPDATE payments p SET user_id = u.id FROM users u WHERE u.phone_number = p.phone_number AND p.user_id IS NULL;
UPDATE rotation_challenges r SET user_id = u.id FROM users u WHERE u.phone_number = r.phone_number AND r.user_id IS NULL;

CREATE OR REPLACE FUNCTION enforce_account_id_link() RETURNS trigger AS $$
DECLARE owner_phone text;
DECLARE resolved_user_id uuid;
BEGIN
  IF NEW.user_id IS NULL THEN
    SELECT id INTO resolved_user_id FROM users WHERE phone_number = NEW.phone_number;
    IF resolved_user_id IS NULL THEN
      RAISE EXCEPTION 'account owner is unknown' USING ERRCODE = '23503';
    END IF;
    -- An old-shape UPDATE cannot use a changed phone to silently reassign a row.
    IF TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND resolved_user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'account reassignment requires an explicit matching user_id' USING ERRCODE = '23514';
    END IF;
    NEW.user_id := resolved_user_id;
  END IF;

  SELECT phone_number INTO owner_phone FROM users WHERE id = NEW.user_id;
  IF owner_phone IS NULL THEN
    RAISE EXCEPTION 'account owner is unknown' USING ERRCODE = '23503';
  END IF;
  IF owner_phone <> NEW.phone_number THEN
    RAISE EXCEPTION 'phone_number and user_id name different accounts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS device_identities_account_id_link ON device_identities;
CREATE TRIGGER device_identities_account_id_link BEFORE INSERT OR UPDATE ON device_identities FOR EACH ROW EXECUTE FUNCTION enforce_account_id_link();
DROP TRIGGER IF EXISTS key_rotation_events_account_id_link ON key_rotation_events;
CREATE TRIGGER key_rotation_events_account_id_link BEFORE INSERT OR UPDATE ON key_rotation_events FOR EACH ROW EXECUTE FUNCTION enforce_account_id_link();
DROP TRIGGER IF EXISTS attestations_account_id_link ON attestations;
CREATE TRIGGER attestations_account_id_link BEFORE INSERT OR UPDATE ON attestations FOR EACH ROW EXECUTE FUNCTION enforce_account_id_link();
DROP TRIGGER IF EXISTS payments_account_id_link ON payments;
CREATE TRIGGER payments_account_id_link BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION enforce_account_id_link();
DROP TRIGGER IF EXISTS rotation_challenges_account_id_link ON rotation_challenges;
CREATE TRIGGER rotation_challenges_account_id_link BEFORE INSERT OR UPDATE ON rotation_challenges FOR EACH ROW EXECUTE FUNCTION enforce_account_id_link();

CREATE INDEX IF NOT EXISTS idx_device_identities_user_id ON device_identities (user_id);
CREATE INDEX IF NOT EXISTS idx_key_rotation_events_user_id ON key_rotation_events (user_id);
CREATE INDEX IF NOT EXISTS idx_attestations_user_id ON attestations (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_rotation_challenges_user_id ON rotation_challenges (user_id);
