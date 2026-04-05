ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS evidence_level VARCHAR(20) DEFAULT 'self_reported';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS corroboration_flags JSONB DEFAULT '{}'::jsonb;

-- Backfill: entries with a signature are device_signed
UPDATE ledger_entries SET evidence_level = 'device_signed'
WHERE evidence_level = 'self_reported' AND signature IS NOT NULL AND signature <> '';

-- Entries that have been synced are server_attested (they passed server-side sig verification)
UPDATE ledger_entries SET evidence_level = 'server_attested'
WHERE evidence_level = 'device_signed' AND synced_at IS NOT NULL;

-- Values for evidence_level: 'self_reported', 'device_signed', 'server_attested', 'corroborated'
