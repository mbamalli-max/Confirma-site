-- M1b: account UUIDs, rather than phone numbers, are the ownership key.
-- migrate.js executes this file in one transaction.

-- Validate before changing anything.  Phone equality is a pre-upgrade invariant
-- only: after this migration child phone values are immutable historical snapshots.
DO $$
DECLARE bad_count bigint;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM (
    SELECT id FROM users WHERE id IS NULL
    UNION ALL
    SELECT id FROM users GROUP BY id HAVING COUNT(*) > 1
  ) invalid_ids;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'account-id primary-key migration found % NULL or duplicate users.id values', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count FROM (
    SELECT 1 FROM device_identities d LEFT JOIN users u ON u.id = d.user_id WHERE d.user_id IS NULL OR u.id IS NULL OR u.phone_number IS DISTINCT FROM d.phone_number
    UNION ALL SELECT 1 FROM key_rotation_events k LEFT JOIN users u ON u.id = k.user_id WHERE k.user_id IS NULL OR u.id IS NULL OR u.phone_number IS DISTINCT FROM k.phone_number
    UNION ALL SELECT 1 FROM attestations a LEFT JOIN users u ON u.id = a.user_id WHERE a.user_id IS NULL OR u.id IS NULL OR u.phone_number IS DISTINCT FROM a.phone_number
    UNION ALL SELECT 1 FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.user_id IS NULL OR u.id IS NULL OR u.phone_number IS DISTINCT FROM p.phone_number
    UNION ALL SELECT 1 FROM rotation_challenges r LEFT JOIN users u ON u.id = r.user_id WHERE r.user_id IS NULL OR u.id IS NULL OR u.phone_number IS DISTINCT FROM r.phone_number
  ) invalid_links;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'account-id primary-key migration found % NULL, orphaned, or phone-mismatched account links', bad_count;
  END IF;
END $$;

-- Discover the deployed names; PostgreSQL-generated names are not an API.
DO $$
DECLARE child_table text;
DECLARE constraint_name text;
BEGIN
  FOR child_table, constraint_name IN
    SELECT child.relname, c.conname
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN unnest(c.conkey) AS key(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = key.attnum
    WHERE c.contype = 'f'
      AND ns.nspname = current_schema()
      AND parent.relname = 'users'
      AND child.relname IN ('device_identities', 'key_rotation_events', 'attestations', 'payments')
      AND a.attname = 'phone_number'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', child_table, constraint_name);
  END LOOP;
END $$;

ALTER TABLE device_identities ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE key_rotation_events ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE attestations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE payments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE rotation_challenges ALTER COLUMN user_id SET NOT NULL;

-- The unique index was introduced in the baseline precisely so REFERENCES users(id)
-- remains valid when the old phone primary key is replaced. The catalog guards
-- also make a manual rerun safe if a runner was interrupted after its COMMIT.
DO $$
DECLARE primary_columns text[];
BEGIN
  SELECT array_agg(a.attname ORDER BY key.ordinality) INTO primary_columns
  FROM pg_constraint c
  JOIN unnest(c.conkey) WITH ORDINALITY key(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
  WHERE c.conrelid = 'users'::regclass AND c.contype = 'p';
  IF primary_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey;
    ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY USING INDEX idx_users_id_unique;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN unnest(c.conkey) key(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
    WHERE c.conrelid = 'users'::regclass AND c.contype IN ('p', 'u') AND a.attname = 'phone_number'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
  END IF;
END $$;
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;

ALTER TABLE device_identities ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE key_rotation_events ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE attestations ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE rotation_challenges ALTER COLUMN phone_number DROP NOT NULL;

DROP TRIGGER IF EXISTS device_identities_account_id_link ON device_identities;
DROP TRIGGER IF EXISTS key_rotation_events_account_id_link ON key_rotation_events;
DROP TRIGGER IF EXISTS attestations_account_id_link ON attestations;
DROP TRIGGER IF EXISTS payments_account_id_link ON payments;
DROP TRIGGER IF EXISTS rotation_challenges_account_id_link ON rotation_challenges;
DROP FUNCTION IF EXISTS enforce_account_id_link();
