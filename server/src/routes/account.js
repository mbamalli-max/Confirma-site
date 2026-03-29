import { authenticateRequest, normalizePhoneNumber } from "../auth-utils.js";
import { query } from "../db.js";

function normalizeCountry(value) {
  const country = String(value || "").trim().toUpperCase();
  return country ? country.slice(0, 2) : null;
}

function normalizePreferredLabels(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

async function ensureAccountRecoverySchema() {
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()`);
  await query(`UPDATE users SET id = gen_random_uuid() WHERE id IS NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id_unique ON users(id)`);
  await query(`ALTER TABLE users ALTER COLUMN id SET NOT NULL`);
  await query(`ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await query(`ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`);
  await query(
    `
      CREATE TABLE IF NOT EXISTS profiles (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        business_name TEXT,
        country CHAR(2),
        business_type_id TEXT,
        sector_id TEXT,
        preferred_labels JSONB DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `
  );
}

async function getUserRow(phoneNumber) {
  const result = await query(
    `
      SELECT id, phone_number
      FROM users
      WHERE phone_number = $1
      LIMIT 1
    `,
    [normalizePhoneNumber(phoneNumber)]
  );
  return result.rows[0] || null;
}

function buildProfileResponse(row, fallbackPhoneNumber) {
  if (!row) {
    return { profile: null };
  }

  return {
    profile: {
      name: row.name || "",
      business_name: row.business_name || "",
      country: row.country || "",
      business_type_id: row.business_type_id || "",
      sector_id: row.sector_id || "",
      preferred_labels: normalizePreferredLabels(row.preferred_labels),
      phone: row.phone_number || fallbackPhoneNumber || ""
    }
  };
}

export async function registerAccountRoutes(app) {
  await ensureAccountRecoverySchema();

  app.get("/records", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const offset = Math.max(0, Number.parseInt(request.query?.offset, 10) || 0);
    const result = await query(
      `
        SELECT
          le.entry_id,
          le.device_identity,
          le.entry_hash,
          le.prev_entry_hash,
          le.signature,
          le.public_key_fingerprint,
          EXTRACT(EPOCH FROM le.confirmed_at)::bigint AS confirmed_at,
          le.payload
        FROM ledger_entries le
        INNER JOIN device_identities di
          ON di.device_identity = le.device_identity
        INNER JOIN users u
          ON u.phone_number = di.phone_number
        WHERE u.phone_number = $1
        ORDER BY le.confirmed_at ASC, le.device_identity ASC, le.entry_id ASC
        LIMIT 1000 OFFSET $2
      `,
      [auth.phone_number, offset]
    );

    return {
      records: result.rows.map((row) => {
        const payload = row.payload || {};
        const transactionType = String(payload.transaction_type || payload.action || row.action || "").trim();
        return {
          entry_id: Number(row.entry_id || 0),
          action: transactionType,
          transaction_type: transactionType,
          label: payload.label || "",
          normalized_label: payload.normalized_label || "",
          amount_minor: Number(payload.amount_minor || 0),
          currency: payload.currency || "NGN",
          counterparty: payload.counterparty ?? null,
          source_account: payload.source_account ?? null,
          destination_account: payload.destination_account ?? null,
          business_type_id: payload.business_type_id || "",
          sector_id: payload.sector_id || "",
          country: payload.country || "",
          input_mode: payload.input_mode || null,
          confirmation_state: payload.confirmation_state || null,
          reversed_entry_hash: payload.reversed_entry_hash ?? null,
          reversed_transaction_type: payload.reversed_transaction_type ?? null,
          confirmed_at: Number(row.confirmed_at || 0),
          entry_hash: row.entry_hash,
          prev_entry_hash: row.prev_entry_hash,
          signature: row.signature,
          public_key_fingerprint: row.public_key_fingerprint || null,
          device_identity: row.device_identity
        };
      })
    };
  });

  app.get("/profile", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const user = await getUserRow(auth.phone_number);
    if (!user) {
      return { profile: null };
    }

    const result = await query(
      `
        SELECT
          p.name,
          p.business_name,
          p.country,
          p.business_type_id,
          p.sector_id,
          p.preferred_labels,
          u.phone_number
        FROM profiles p
        INNER JOIN users u
          ON u.id = p.user_id
        WHERE p.user_id = $1
        LIMIT 1
      `,
      [user.id]
    );

    return buildProfileResponse(result.rows[0] || null, user.phone_number);
  });

  app.post("/profile", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const user = await getUserRow(auth.phone_number);
    if (!user) {
      return reply.code(404).send({ error: "User account not found." });
    }

    const body = request.body || {};
    await query(
      `
        INSERT INTO profiles (
          user_id,
          name,
          business_name,
          country,
          business_type_id,
          sector_id,
          preferred_labels,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          business_name = EXCLUDED.business_name,
          country = EXCLUDED.country,
          business_type_id = EXCLUDED.business_type_id,
          sector_id = EXCLUDED.sector_id,
          preferred_labels = EXCLUDED.preferred_labels,
          updated_at = NOW()
      `,
      [
        user.id,
        String(body.name || "").trim() || null,
        String(body.business_name || "").trim() || null,
        normalizeCountry(body.country),
        String(body.business_type_id || "").trim() || null,
        String(body.sector_id || "").trim() || null,
        JSON.stringify(normalizePreferredLabels(body.preferred_labels))
      ]
    );

    return { ok: true };
  });

  app.get("/devices", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const result = await query(
      `
        SELECT device_identity, created_at, last_seen_at, revoked_at
        FROM device_identities
        WHERE phone_number = $1
        ORDER BY created_at DESC
      `,
      [auth.phone_number]
    );

    return {
      devices: result.rows.map((row) => ({
        device_identity: row.device_identity,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at,
        is_current: Boolean(auth.device_identity && auth.device_identity === row.device_identity)
      }))
    };
  });
}
