import { authenticateRequest, generateOtpCode, isValidEmail, normalizeEmail, normalizeInternationalPhoneNumber, phoneChangeCodeDigest, phoneChangeCodeMatches, phoneDigits, normalizePhoneNumber } from "../auth-utils.js";
import { query, withTransaction } from "../db.js";
import { config } from "../config.js";
import { UNLISTED_BUSINESS_TYPE_ID } from "../business-catalog.js";
import {
  catalogSector,
  effectiveSector,
  hasBusinessProfile,
  isProfileComplete,
  readRequestedSector,
  resolveNonCatalogSector
} from "../sector-assignment.js";

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
const PHONE_CHANGE_WINDOW = "1 hour";
const PHONE_CHANGE_TTL = "10 minutes";

let resendModulePromise = null;
async function sendPhoneChangeEmail(email, code) {
  if (!config.resendApiKey) throw new Error("Email delivery is not configured.");
  if (!resendModulePromise) resendModulePromise = import("resend");
  const { Resend } = await resendModulePromise;
  await new Resend(config.resendApiKey).emails.send({
    from: config.resendFromEmail,
    to: email,
    subject: "Confirm your Konfirmata phone number change",
    text: `Your Konfirmata code is ${code}. It expires in 10 minutes. This code changes the phone number on your account; it does not verify the new number.`
  });
}

async function sendPhoneChangeNotice(email, changedAt) {
  if (!config.resendApiKey) throw new Error("Email delivery is not configured.");
  if (!resendModulePromise) resendModulePromise = import("resend");
  const { Resend } = await resendModulePromise;
  await new Resend(config.resendApiKey).emails.send({
    from: config.resendFromEmail,
    to: email,
    subject: "Your Konfirmata phone number was changed",
    text: `The phone number on your Konfirmata account was changed on ${new Date(changedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}. If this wasn't you, sign out everywhere and contact support.`
  });
}

function isPhoneConflict(error) {
  return (error?.code === "23P01" && error?.constraint === "users_phone_digits_excl")
    || (error?.code === "23505" && error?.constraint === "users_phone_number_key");
}

function retryAfterSeconds(row) {
  return Math.max(1, Math.ceil((new Date(row.created_at).getTime() + 60 * 60 * 1000 - Date.now()) / 1000));
}

function cleanBusinessDescription(value) {
  // Strip control characters, then trim. Length is counted in characters, as Postgres char_length does.
  return String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

// The server owns the business type / sector / description pairing; the phone's sector for a listed
// type and any review field are never trusted. Returns { error } or the values to store.
// `stored` is the current profile row (or null): a client that omits business details never erases
// a stored business, sector or description (older app versions).
function resolveBusinessFields(body, stored) {
  const businessTypeId = String(body.business_type_id || "").trim();
  const sector = readRequestedSector(body);
  const confirmed = body.sector_confirmed === true;

  if (businessTypeId === UNLISTED_BUSINESS_TYPE_ID) {
    if (sector.error) return { error: sector.error };
    const hasDescription = Object.hasOwn(body, "business_description");
    let description = null;
    let keepStoredDescription = false;
    if (!hasDescription) {
      // Older app versions do not send the field: keep whatever description is stored.
      keepStoredDescription = true;
    } else {
      description = cleanBusinessDescription(body.business_description);
      const length = [...description].length;
      if (length < BUSINESS_DESCRIPTION_MIN || length > BUSINESS_DESCRIPTION_MAX) {
        return { error: `Describe your business in ${BUSINESS_DESCRIPTION_MIN} to ${BUSINESS_DESCRIPTION_MAX} characters.` };
      }
    }
    const assigned = resolveNonCatalogSector({ requested: sector.requested, confirmed, stored });
    return {
      businessTypeId,
      sectorId: assigned.sectorId,
      sectorSource: assigned.source,
      preferredLabels: [],
      description,
      keepStoredDescription,
      keepStoredBusiness: false
    };
  }

  if (businessTypeId) {
    const fromCatalog = catalogSector(businessTypeId);
    if (!fromCatalog) {
      return { error: "Unknown business type." };
    }
    return {
      businessTypeId,
      sectorId: fromCatalog,
      sectorSource: "catalog",
      preferredLabels: normalizePreferredLabels(body.preferred_labels),
      description: null,
      keepStoredDescription: false,
      keepStoredBusiness: false
    };
  }

  // No business type: a legacy sector-only profile, or a save with no business details at all.
  if (sector.error) return { error: sector.error };
  if (!sector.requested) {
    if (hasBusinessProfile(stored)) {
      return { keepStoredBusiness: true, keepStoredDescription: false };
    }
    return {
      businessTypeId: null,
      sectorId: null,
      sectorSource: null,
      preferredLabels: normalizePreferredLabels(body.preferred_labels),
      description: null,
      keepStoredDescription: false,
      keepStoredBusiness: false
    };
  }
  const assigned = resolveNonCatalogSector({ requested: sector.requested, confirmed, stored });
  return {
    businessTypeId: null,
    sectorId: assigned.sectorId,
    sectorSource: assigned.source,
    preferredLabels: normalizePreferredLabels(body.preferred_labels),
    description: null,
    keepStoredDescription: false,
    keepStoredBusiness: false
  };
}

async function getUserRow(accountId) {
  const result = await query(
    `
      SELECT id, phone_number
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [accountId]
  );
  return result.rows[0] || null;
}

function buildProfileResponse(row, fallbackPhoneNumber, accountId = null) {
  if (!row) {
    return { account_id: accountId, profile: null };
  }
  // The same sector rule as saves and the admin analytics build; older apps ignore the two new fields.
  const assigned = effectiveSector(row);

  return {
    account_id: accountId,
    profile: {
      name: row.name || "",
      business_name: row.business_name || "",
      country: row.country || "",
      operating_region: row.operating_region || row.country || "",
      language: row.language || "en",
      business_type_id: row.business_type_id || "",
      sector_id: assigned ? assigned.sectorId : "",
      sector_source: assigned ? assigned.source : null,
      profile_complete: isProfileComplete(row),
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

async function loadProfileRow(userId) {
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
        p.sector_source,
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
    [userId]
  );
  return result.rows[0] || null;
}

// S2 "fill_missing": recover a business profile the phone holds but the server never received.
// One statement writes only when the stored row has no business at the moment of writing, so a
// profile saved concurrently from another device is never overwritten. Non-business fields the
// server already holds are kept; only empty ones are filled.
async function fillMissingProfile({ user, body, business, email }) {
  const result = await query(
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
        sector_source,
        preferred_labels,
        business_description,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        name = COALESCE(NULLIF(profiles.name, ''), EXCLUDED.name),
        business_name = COALESCE(NULLIF(profiles.business_name, ''), EXCLUDED.business_name),
        phone_number = COALESCE(NULLIF(profiles.phone_number, ''), EXCLUDED.phone_number),
        country = COALESCE(NULLIF(profiles.country, ''), EXCLUDED.country),
        operating_region = COALESCE(NULLIF(profiles.operating_region, ''), EXCLUDED.operating_region),
        language = COALESCE(NULLIF(profiles.language, ''), EXCLUDED.language),
        business_type_id = EXCLUDED.business_type_id,
        sector_id = EXCLUDED.sector_id,
        sector_source = EXCLUDED.sector_source,
        preferred_labels = EXCLUDED.preferred_labels,
        business_description = EXCLUDED.business_description,
        updated_at = NOW()
      WHERE profiles.business_type_id IS NULL
        AND profiles.sector_id IS NULL
        AND profiles.business_description IS NULL
      RETURNING user_id
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
      business.sectorSource,
      JSON.stringify(business.preferredLabels),
      business.description
    ]
  );
  const applied = result.rowCount === 1;
  if (applied && email) {
    await query(
      `UPDATE users SET email = $2 WHERE id = $1 AND (email IS NULL OR email = '')`,
      [user.id, email]
    );
  }
  return applied;
}

export async function registerAccountRoutes(app, {
  // Dependency injection is intentionally narrow: production retains the module
  // senders while database tests can capture a code without a Resend request.
  sendPhoneChangeEmail: sendCode = sendPhoneChangeEmail,
  sendPhoneChangeNotice: sendNotice = sendPhoneChangeNotice
} = {}) {
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
        WHERE di.user_id = $1
        ORDER BY le.confirmed_at ASC, le.device_identity ASC, le.entry_id ASC
        LIMIT 1000 OFFSET $2
      `,
      [auth.account_id, offset]
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

    const user = await getUserRow(auth.account_id);
    if (!user) {
      return { profile: null };
    }

    return buildProfileResponse(await loadProfileRow(user.id), user.phone_number, user.id);
  });

  app.post("/profile", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const user = await getUserRow(auth.account_id);
    if (!user) {
      return reply.code(404).send({ error: "User account not found." });
    }

    const body = request.body && typeof request.body === "object" ? request.body : {};
    const email = isValidEmail(body.email) ? normalizeEmail(body.email) : null;
    if (String(body.email || "").trim() && !email) {
      return reply.code(400).send({ error: "Enter a valid email address." });
    }

    const hasMode = Object.hasOwn(body, "mode");
    if (hasMode && body.mode !== "fill_missing") {
      return reply.code(400).send({ error: "Unknown profile save mode." });
    }
    const fillMissing = hasMode;

    const storedResult = await query(
      `SELECT business_type_id, sector_id, sector_source, business_description FROM profiles WHERE user_id = $1 LIMIT 1`,
      [user.id]
    );
    const stored = storedResult.rows[0] || null;
    const business = resolveBusinessFields(body, stored);
    if (business.error) {
      return reply.code(400).send({ error: business.error });
    }
    if (fillMissing) {
      // Recovery sends a complete business; it never relies on stored values.
      if (business.keepStoredBusiness || business.keepStoredDescription || !business.sectorId) {
        return reply.code(400).send({ error: "A business type, sector or description is required." });
      }
      try {
        const applied = await fillMissingProfile({ user, body, business, email });
        return { ok: true, applied, ...buildProfileResponse(await loadProfileRow(user.id), user.phone_number, user.id) };
      } catch (error) {
        if (error?.code === "23514" && /profiles_(unlisted_description_pairing|business_description_length)/.test(error.constraint || "")) {
          return reply.code(400).send({ error: "Describe your business in 3 to 60 characters." });
        }
        throw error;
      }
    }
    if (business.keepStoredDescription) {
      if (!stored?.business_description) {
        return reply.code(400).send({ error: "Describe your business in 3 to 60 characters." });
      }
      // CHECK constraints apply to the proposed insert row too, so carry the stored value;
      // the UPDATE branch still keeps whatever is stored at write time.
      business.description = stored.business_description;
    }
    if (business.keepStoredBusiness) {
      // No business details sent and a business is stored: carry the stored values so the proposed
      // insert row passes the CHECKs; the UPDATE branch keeps whatever is stored at write time.
      business.businessTypeId = stored.business_type_id;
      business.sectorId = stored.sector_id;
      business.sectorSource = stored.sector_source;
      business.description = stored.business_description;
      business.preferredLabels = [];
    }

    if (email) {
      await query(
        `
          UPDATE users
          SET email = $2
          WHERE id = $1
        `,
        [user.id, email]
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
            sector_source,
            preferred_labels,
            business_description,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $13, $10::jsonb, $11, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            business_name = EXCLUDED.business_name,
            phone_number = EXCLUDED.phone_number,
            country = EXCLUDED.country,
            operating_region = EXCLUDED.operating_region,
            language = EXCLUDED.language,
            business_type_id = CASE WHEN $14::boolean THEN profiles.business_type_id ELSE EXCLUDED.business_type_id END,
            sector_id = CASE WHEN $14::boolean THEN profiles.sector_id ELSE EXCLUDED.sector_id END,
            sector_source = CASE WHEN $14::boolean THEN profiles.sector_source ELSE EXCLUDED.sector_source END,
            preferred_labels = CASE WHEN $14::boolean THEN profiles.preferred_labels ELSE EXCLUDED.preferred_labels END,
            business_description = CASE
              WHEN $12::boolean OR $14::boolean THEN profiles.business_description
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
          business.keepStoredDescription,
          business.sectorSource,
          business.keepStoredBusiness
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

  app.post("/account/phone-change/request", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    const phoneNumber = normalizeInternationalPhoneNumber(request.body?.new_phone_number);
    if (!phoneNumber) return reply.code(400).send({ error: "Enter an international phone number with 7 to 15 digits." });
    const code = generateOtpCode();
    let outcome;
    try {
      outcome = await withTransaction(async (database) => {
        // This is intentionally the first statement in every M2 transaction.
        const locked = await database.query("SELECT id, phone_number, email, email_verified FROM users WHERE id = $1 FOR UPDATE", [auth.account_id]);
        const user = locked.rows[0];
        if (!user) return { kind: "missing" };
        if (!user.email_verified || !user.email) return { kind: "email_required" };
        const failed = await database.query("SELECT created_at FROM phone_change_failed_guesses WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at ASC", [user.id]);
        if (failed.rowCount >= 5) return { kind: "limited", retry_after: retryAfterSeconds(failed.rows[0]) };
        const requests = await database.query("SELECT created_at FROM phone_change_challenges WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at ASC", [user.id]);
        if (requests.rowCount >= 5) return { kind: "limited", retry_after: retryAfterSeconds(requests.rows[0]) };
        if (phoneDigits(user.phone_number) === phoneDigits(phoneNumber)) return { kind: "own" };
        const taken = await database.query("SELECT 1 FROM users WHERE regexp_replace(phone_number, '[^0-9]', '', 'g') = $1 AND id <> $2 LIMIT 1", [phoneDigits(phoneNumber), user.id]);
        if (taken.rowCount) return { kind: "in_use" };
        await database.query("UPDATE phone_change_challenges SET superseded_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL", [user.id]);
        const inserted = await database.query("INSERT INTO phone_change_challenges (user_id, new_phone_number, code_digest, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes') RETURNING id", [user.id, phoneNumber, "pending"]);
        const digest = phoneChangeCodeDigest({ challengeId: inserted.rows[0].id, userId: user.id, newPhoneDigits: phoneDigits(phoneNumber), code });
        await database.query("UPDATE phone_change_challenges SET code_digest = $2 WHERE id = $1", [inserted.rows[0].id, digest]);
        return { kind: "send", challenge_id: inserted.rows[0].id, email: user.email };
      });
    } catch (error) {
      if (isPhoneConflict(error)) return reply.code(409).send({ code: "phone_in_use", error: "This phone number is already linked to another account." });
      request.log.error({ err: { message: error?.message }, route: "phone_change_request" }, "Phone change request failed");
      return reply.code(500).send({ error: "Unable to request a phone-number change right now." });
    }
    if (outcome.kind === "email_required") return reply.code(403).send({ error: "A verified email is needed before you can change your phone number." });
    if (outcome.kind === "limited") return reply.code(429).send({ error: "Too many phone-change attempts. Try again later.", retry_after: outcome.retry_after });
    if (outcome.kind === "own") return reply.code(400).send({ error: "That is already your number." });
    if (outcome.kind === "in_use") return reply.code(409).send({ code: "phone_in_use", error: "This phone number is already linked to another account." });
    if (outcome.kind === "missing") return reply.code(404).send({ error: "User account not found." });
    try {
      await sendCode(outcome.email, code);
    } catch (error) {
      // Match email sign-in's development-only delivery fallback. In this case
      // the challenge remains usable; a real delivery failure still supersedes it.
      if (config.allowDevOtp) {
        return { ok: true, ttl_minutes: 10, delivery: "development", dev_code: code };
      }
      await query("UPDATE phone_change_challenges SET superseded_at = NOW() WHERE id = $1 AND consumed_at IS NULL", [outcome.challenge_id]);
      request.log.warn({ err: error, route: "phone_change_request" }, "Phone change email delivery failed");
      return reply.code(502).send({ error: "We could not send the email code. Please try again." });
    }
    return { ok: true, ttl_minutes: 10 };
  });

  app.post("/account/phone-change/confirm", {
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    const phoneNumber = normalizeInternationalPhoneNumber(request.body?.new_phone_number);
    const code = String(request.body?.code || "").trim();
    if (!phoneNumber || !/^\d{6}$/.test(code)) return reply.code(400).send({ error: "Enter the phone number and six-digit email code." });
    let outcome;
    try {
      outcome = await withTransaction(async (database) => {
        const locked = await database.query("SELECT id, email FROM users WHERE id = $1 FOR UPDATE", [auth.account_id]);
        const user = locked.rows[0];
        if (!user) return { kind: "missing" };
        const failures = await database.query("SELECT created_at FROM phone_change_failed_guesses WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at ASC", [user.id]);
        if (failures.rowCount >= 5) return { kind: "limited", retry_after: retryAfterSeconds(failures.rows[0]) };
        const found = await database.query("SELECT id, new_phone_number, code_digest FROM phone_change_challenges WHERE user_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [user.id]);
        const challenge = found.rows[0];
        const matches = challenge && phoneDigits(challenge.new_phone_number) === phoneDigits(phoneNumber) && phoneChangeCodeMatches(challenge.code_digest, { challengeId: challenge.id, userId: user.id, newPhoneDigits: phoneDigits(phoneNumber), code });
        if (!matches) {
          await database.query("INSERT INTO phone_change_failed_guesses (user_id, challenge_id) VALUES ($1, $2)", [user.id, challenge?.id || null]);
          return { kind: "wrong", guesses_left: Math.max(0, 4 - failures.rowCount) };
        }
        await database.query("UPDATE users SET phone_number = $2, phone_verified = FALSE WHERE id = $1", [user.id, phoneNumber]);
        await database.query("UPDATE profiles SET phone_number = $2 WHERE user_id = $1", [user.id, phoneNumber]);
        await database.query("UPDATE phone_change_challenges SET consumed_at = NOW() WHERE id = $1", [challenge.id]);
        const audit = await database.query("INSERT INTO account_phone_changes (user_id, device_identity) VALUES ($1, $2) RETURNING id, changed_at", [user.id, auth.device_identity]);
        return { kind: "changed", email: user.email, audit_id: audit.rows[0].id, changed_at: audit.rows[0].changed_at };
      });
    } catch (error) {
      if (isPhoneConflict(error)) return reply.code(409).send({ code: "phone_in_use", error: "This phone number is already linked to another account." });
      request.log.error({ err: { message: error?.message }, route: "phone_change_confirm" }, "Phone change failed");
      return reply.code(500).send({ error: "Unable to change the phone number right now." });
    }
    if (outcome.kind === "limited") return reply.code(429).send({ error: "Too many phone-change attempts. Try again later.", retry_after: outcome.retry_after });
    if (outcome.kind === "wrong") return reply.code(400).send({ error: "That code is incorrect or has expired.", guesses_left: outcome.guesses_left });
    if (outcome.kind === "missing") return reply.code(404).send({ error: "User account not found." });
    try {
      await sendNotice(outcome.email, outcome.changed_at);
      await query("UPDATE account_phone_changes SET notice_sent = TRUE WHERE id = $1", [outcome.audit_id]);
    } catch (error) {
      request.log.warn({ err: error, route: "phone_change_notice" }, "Phone change notice delivery failed");
    }
    return { ok: true, phone_number: phoneNumber, phone_verified: false };
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
        WHERE user_id = $1
        ORDER BY created_at DESC
      `,
      [auth.account_id]
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
