import { authenticateRequest, isValidEmail, normalizeEmail, normalizePhoneNumber } from "../auth-utils.js";
import { query } from "../db.js";
import { BUSINESS_TYPE_CATALOG, SECTOR_IDS, UNLISTED_BUSINESS_TYPE_ID } from "../business-catalog.js";

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

const BUSINESS_DESCRIPTION_MIN = 3;
const BUSINESS_DESCRIPTION_MAX = 60;

function cleanBusinessDescription(value) {
  // Strip control characters, then trim. Length is counted in characters, as Postgres char_length does.
  return String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

// The server owns the business type / sector / description pairing; the phone's sector and any review
// field are never trusted. Returns { error } or the values to store plus whether to keep the stored description.
function resolveBusinessFields(body) {
  const businessTypeId = String(body.business_type_id || "").trim();

  if (businessTypeId === UNLISTED_BUSINESS_TYPE_ID) {
    const hasDescription = Object.hasOwn(body, "business_description");
    if (!hasDescription) {
      // Older app versions do not send the field: keep whatever description is stored.
      return { businessTypeId, sectorId: null, preferredLabels: [], description: null, keepStoredDescription: true };
    }
    const description = cleanBusinessDescription(body.business_description);
    const length = [...description].length;
    if (length < BUSINESS_DESCRIPTION_MIN || length > BUSINESS_DESCRIPTION_MAX) {
      return { error: `Describe your business in ${BUSINESS_DESCRIPTION_MIN} to ${BUSINESS_DESCRIPTION_MAX} characters.` };
    }
    return { businessTypeId, sectorId: null, preferredLabels: [], description, keepStoredDescription: false };
  }

  if (businessTypeId) {
    const catalogEntry = Object.hasOwn(BUSINESS_TYPE_CATALOG, businessTypeId) ? BUSINESS_TYPE_CATALOG[businessTypeId] : null;
    if (!catalogEntry) {
      return { error: "Unknown business type." };
    }
    return {
      businessTypeId,
      sectorId: catalogEntry.sector_id,
      preferredLabels: normalizePreferredLabels(body.preferred_labels),
      description: null,
      keepStoredDescription: false
    };
  }

  // Legacy profile with a sector but no business type.
  const sectorId = String(body.sector_id || "").trim();
  if (sectorId && !SECTOR_IDS.includes(sectorId)) {
    return { error: "Unknown business sector." };
  }
  return {
    businessTypeId: null,
    sectorId: sectorId || null,
    preferredLabels: normalizePreferredLabels(body.preferred_labels),
    description: null,
    keepStoredDescription: false
  };
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

function buildProfileResponse(row, fallbackPhoneNumber, accountId = null) {
  if (!row) {
    return { account_id: accountId, profile: null };
  }

  return {
    account_id: accountId,
    profile: {
      name: row.name || "",
      business_name: row.business_name || "",
      country: row.country || "",
      operating_region: row.operating_region || row.country || "",
      language: row.language || "en",
      business_type_id: row.business_type_id || "",
      sector_id: row.sector_id || "",
      business_description: row.business_description || "",
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
          p.business_description,
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

    return buildProfileResponse(result.rows[0] || null, user.phone_number, user.id);
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

    const body = request.body && typeof request.body === "object" ? request.body : {};
    const email = isValidEmail(body.email) ? normalizeEmail(body.email) : null;
    if (String(body.email || "").trim() && !email) {
      return reply.code(400).send({ error: "Enter a valid email address." });
    }

    const business = resolveBusinessFields(body);
    if (business.error) {
      return reply.code(400).send({ error: business.error });
    }
    if (business.keepStoredDescription) {
      const stored = await query(
        `SELECT business_description FROM profiles WHERE user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (!stored.rows[0]?.business_description) {
        return reply.code(400).send({ error: "Describe your business in 3 to 60 characters." });
      }
      // CHECK constraints apply to the proposed insert row too, so carry the stored value;
      // the UPDATE branch still keeps whatever is stored at write time.
      business.description = stored.rows[0].business_description;
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

    try {
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
            business_description,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW())
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
            business_description = CASE
              WHEN $12::boolean THEN profiles.business_description
              ELSE EXCLUDED.business_description
            END,
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
          business.businessTypeId,
          business.sectorId,
          JSON.stringify(business.preferredLabels),
          business.description,
          business.keepStoredDescription
        ]
      );
    } catch (error) {
      // A concurrent save can clear the stored description between the check above and this write.
      if (error?.code === "23514" && /profiles_(unlisted_description_pairing|business_description_length)/.test(error.constraint || "")) {
        return reply.code(400).send({ error: "Describe your business in 3 to 60 characters." });
      }
      throw error;
    }

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
