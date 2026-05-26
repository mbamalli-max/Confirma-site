import { authenticateRequest, isValidEmail, normalizeEmail, normalizePhoneNumber } from "../auth-utils.js";
import { query } from "../db.js";

function normalizeCountry(value) {
  const country = String(value || "").trim().toUpperCase();
  return country ? country.slice(0, 2) : null;
}

function normalizeLanguage(value) {
  const language = String(value || "").trim().toLowerCase();
  return language ? language.slice(0, 10) : "en";
}

function normalizePreferredLabels(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
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
      operating_region: row.operating_region || row.country || "",
      language: row.language || "en",
      business_type_id: row.business_type_id || "",
      sector_id: row.sector_id || "",
      preferred_labels: normalizePreferredLabels(row.preferred_labels),
      phone: row.phone_number || fallbackPhoneNumber || "",
      email: row.email || "",
      email_verified: Boolean(row.email_verified),
      phone_verified: Boolean(row.phone_verified),
      plan: row.plan || null,
      plan_activated_at: row.plan_activated_at || null
    }
  };
}

export async function registerAccountRoutes(app) {
  app.get("/records", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
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

  app.get("/profile", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
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
          p.operating_region,
          p.language,
          p.business_type_id,
          p.sector_id,
          p.preferred_labels,
          p.plan,
          p.plan_activated_at,
          u.phone_number,
          u.email,
          u.email_verified,
          u.phone_verified
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

  app.post("/profile", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const user = await getUserRow(auth.phone_number);
    if (!user) {
      return reply.code(404).send({ error: "User account not found." });
    }

    const body = request.body || {};
    const email = isValidEmail(body.email) ? normalizeEmail(body.email) : null;
    if (String(body.email || "").trim() && !email) {
      return reply.code(400).send({ error: "Enter a valid email address." });
    }

    if (email) {
      await query(
        `
          UPDATE users
          SET email = $2
          WHERE phone_number = $1
        `,
        [user.phone_number, email]
      );
    }

    await query(
      `
        INSERT INTO profiles (
          user_id,
          name,
          business_name,
          phone_number,
          country,
          operating_region,
          language,
          business_type_id,
          sector_id,
          preferred_labels,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          business_name = EXCLUDED.business_name,
          phone_number = EXCLUDED.phone_number,
          country = EXCLUDED.country,
          operating_region = EXCLUDED.operating_region,
          language = EXCLUDED.language,
          business_type_id = EXCLUDED.business_type_id,
          sector_id = EXCLUDED.sector_id,
          preferred_labels = EXCLUDED.preferred_labels,
          updated_at = NOW()
      `,
      [
        user.id,
        String(body.name || "").trim() || null,
        String(body.business_name || "").trim() || null,
        user.phone_number,
        normalizeCountry(body.country),
        normalizeCountry(body.operating_region || body.country),
        normalizeLanguage(body.language),
        String(body.business_type_id || "").trim() || null,
        String(body.sector_id || "").trim() || null,
        JSON.stringify(normalizePreferredLabels(body.preferred_labels))
      ]
    );

    return { ok: true };
  });

  app.get("/devices", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
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
