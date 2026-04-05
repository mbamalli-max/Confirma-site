import crypto from "crypto";
import { config } from "../config.js";
import { query } from "../db.js";
import {
  buildAuthReply,
  generateOtpCode,
  hashOtp,
  isValidEmail,
  isValidPhoneNumber,
  normalizeEmail,
  normalizeOtpChannel,
  normalizePhoneNumber
} from "../auth-utils.js";

let schemaReady = false;
let resendModulePromise = null;

async function getResendClient(apiKey) {
  if (!apiKey) {
    throw new Error("Email verification is not configured.");
  }
  if (!resendModulePromise) {
    resendModulePromise = import("resend");
  }
  const { Resend } = await resendModulePromise;
  return new Resend(apiKey);
}

function getOtpIdentifier(channel, body) {
  if (channel === "sms") {
    return normalizePhoneNumber(body?.identifier || body?.phone_number);
  }
  return normalizeEmail(body?.identifier || body?.email);
}

function getOptionalPhoneNumber(body) {
  const phoneNumber = normalizePhoneNumber(body?.phone_number);
  return isValidPhoneNumber(phoneNumber) ? phoneNumber : "";
}

function buildFallbackMessage(channel) {
  if (channel === "sms") {
    return "SMS verification is not available right now. Please use email verification.";
  }
  return "Email verification is not available right now.";
}

function createPhoneAnchorRequiredError() {
  const error = new Error("Add a phone number to your profile before email verification can activate sync on this device.");
  error.statusCode = 409;
  error.code = "phone_anchor_required";
  error.missing = "phone_number";
  return error;
}

async function ensureAuthSchema() {
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()`);
  await query(`UPDATE users SET id = gen_random_uuid() WHERE id IS NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id_unique ON users(id)`);
  await query(`ALTER TABLE users ALTER COLUMN id SET NOT NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users ((LOWER(email))) WHERE email IS NOT NULL`);
  await query(`ALTER TABLE otp_challenges ALTER COLUMN phone_number DROP NOT NULL`);
  await query(`ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS identifier TEXT`);
  await query(`ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sms'`);
  await query(`ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ`);
  await query(`UPDATE otp_challenges SET identifier = COALESCE(identifier, phone_number) WHERE identifier IS NULL`);
  await query(`UPDATE otp_challenges SET channel = COALESCE(NULLIF(channel, ''), 'sms')`);
  await query(
    `
      CREATE INDEX IF NOT EXISTS idx_otp_challenges_identifier_created_at
      ON otp_challenges (identifier, channel, created_at DESC)
    `
  );
}

async function ensureAuthSchemaIfNeeded(request) {
  if (schemaReady) return;
  try {
    await ensureAuthSchema();
    schemaReady = true;
  } catch (error) {
    request.log.error(`Schema init failed, continuing: ${error.message}`);
  }
}

async function getUserByPhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  const result = await query(
    `
      SELECT id, phone_number, email, email_verified, phone_verified
      FROM users
      WHERE phone_number = $1
      LIMIT 1
    `,
    [normalizePhoneNumber(phoneNumber)]
  );
  return result.rows[0] || null;
}

async function getUserByEmail(email) {
  if (!email) return null;
  const result = await query(
    `
      SELECT id, phone_number, email, email_verified, phone_verified
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [normalizeEmail(email)]
  );
  return result.rows[0] || null;
}

async function sendOtpByEmail(email, code) {
  const resend = await getResendClient(config.resendApiKey);
  await resend.emails.send({
    from: config.resendFromEmail,
    to: email,
    subject: "Your Konfirmata verification code",
    text: `Your Konfirmata code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`
  });
}

async function upsertVerifiedUser({ channel, identifier, phoneNumber, email }) {
  if (channel === "sms") {
    await query(
      `
        INSERT INTO users (phone_number, email, email_verified, phone_verified)
        VALUES ($1, $2, FALSE, TRUE)
        ON CONFLICT (phone_number)
        DO UPDATE SET
          email = COALESCE(EXCLUDED.email, users.email),
          phone_verified = TRUE
      `,
      [phoneNumber, email || null]
    );

    return getUserByPhoneNumber(phoneNumber);
  }

  const existingByEmail = await getUserByEmail(email);
  if (existingByEmail) {
    await query(
      `
        UPDATE users
        SET email = $2, email_verified = TRUE
        WHERE phone_number = $1
      `,
      [existingByEmail.phone_number, email]
    );
    return getUserByPhoneNumber(existingByEmail.phone_number);
  }

  if (!phoneNumber) {
    throw createPhoneAnchorRequiredError();
  }

  await query(
    `
      INSERT INTO users (phone_number, email, email_verified, phone_verified)
      VALUES ($1, $2, TRUE, FALSE)
      ON CONFLICT (phone_number)
      DO UPDATE SET
        email = COALESCE(EXCLUDED.email, users.email),
        email_verified = TRUE
    `,
    [phoneNumber, email]
  );

  return getUserByPhoneNumber(phoneNumber);
}

function buildVerificationResponse(user, channel, deviceIdentity = "") {
  return {
    ok: true,
    channel,
    identifier: channel === "email" ? user.email : user.phone_number,
    phone_number: user.phone_number || "",
    email: user.email || "",
    email_verified: Boolean(user.email_verified),
    phone_verified: Boolean(user.phone_verified),
    sms_available: config.smsProviderEnabled,
    ...buildAuthReply(user.phone_number, deviceIdentity, {
      email: user.email || "",
      email_verified: Boolean(user.email_verified),
      phone_verified: Boolean(user.phone_verified)
    })
  };
}

export async function registerAuthRoutes(app) {
  app.post("/auth/otp/request", async (request, reply) => {
    await ensureAuthSchemaIfNeeded(request);
    const channel = normalizeOtpChannel(request.body?.channel || config.otpDefaultChannel);
    const identifier = getOtpIdentifier(channel, request.body);
    const phoneNumber = getOptionalPhoneNumber(request.body);

    if (channel === "email") {
      if (!isValidEmail(identifier)) {
        return reply.code(400).send({ error: "Enter a valid email address." });
      }
      const existingUser = await getUserByEmail(identifier);
      if (!existingUser && !phoneNumber) {
        const error = createPhoneAnchorRequiredError();
        return reply.code(error.statusCode).send({
          error: error.message,
          code: error.code,
          missing: error.missing
        });
      }
    } else {
      if (!config.smsProviderEnabled) {
        return reply.code(503).send({
          error: buildFallbackMessage(channel),
          fallback_channel: "email",
          sms_available: false
        });
      }
      if (!isValidPhoneNumber(identifier)) {
        return reply.code(400).send({ error: "Enter a valid phone number." });
      }
    }

    const rateLimitResult = await query(
      `
        SELECT COUNT(*)::int AS request_count
        FROM otp_challenges
        WHERE identifier = $1
          AND channel = $2
          AND created_at > NOW() - INTERVAL '1 hour'
      `,
      [identifier, channel]
    );

    if ((rateLimitResult.rows[0]?.request_count || 0) >= config.otpRateLimitPerHour) {
      return reply.code(429).send({
        error: channel === "email"
          ? "OTP request limit reached for this email address."
          : "OTP request limit reached for this phone number."
      });
    }

    const code = generateOtpCode();
    const otpHash = hashOtp(identifier, code, channel);

    await query(
      `
        INSERT INTO otp_challenges (phone_number, identifier, channel, otp_hash, expires_at)
        VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)
      `,
      [phoneNumber || null, identifier, channel, otpHash, String(config.otpTtlMinutes)]
    );

    let delivery = channel;
    let devCode = "";

    if (channel === "email") {
      try {
        await sendOtpByEmail(identifier, code);
      } catch (error) {
        if (!config.allowDevOtp) {
          return reply.code(503).send({ error: error.message || "Unable to send email verification code right now." });
        }
        delivery = "development";
        devCode = code;
      }
    } else {
      return reply.code(503).send({
        error: buildFallbackMessage(channel),
        fallback_channel: "email",
        sms_available: false
      });
    }

    return {
      ok: true,
      ttl_minutes: config.otpTtlMinutes,
      channel,
      delivery,
      sms_available: config.smsProviderEnabled,
      ...(devCode ? { dev_code: devCode } : {})
    };
  });

  app.post("/auth/otp/verify", async (request, reply) => {
    await ensureAuthSchemaIfNeeded(request);
    const channel = normalizeOtpChannel(request.body?.channel || config.otpDefaultChannel);
    const identifier = getOtpIdentifier(channel, request.body);
    const code = String(request.body?.code || "").trim();
    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const publicKey = String(request.body?.public_key || "").trim();
    const optionalPhoneNumber = getOptionalPhoneNumber(request.body);
    const optionalEmail = isValidEmail(request.body?.email)
      ? normalizeEmail(request.body?.email)
      : (channel === "email" ? identifier : "");

    if (channel === "email") {
      if (!isValidEmail(identifier) || !/^\d{6}$/.test(code)) {
        return reply.code(400).send({ error: "Email address and 6-digit code are required." });
      }
    } else {
      if (!config.smsProviderEnabled) {
        return reply.code(503).send({
          error: buildFallbackMessage(channel),
          fallback_channel: "email",
          sms_available: false
        });
      }
      if (!isValidPhoneNumber(identifier) || !/^\d{6}$/.test(code)) {
        return reply.code(400).send({ error: "Phone number and 6-digit code are required." });
      }
    }

    if ((deviceIdentity && !publicKey) || (!deviceIdentity && publicKey)) {
      return reply.code(400).send({ error: "device_identity and public_key must be provided together." });
    }

    const otpResult = await query(
      `
        SELECT id, otp_hash, expires_at, verified_at
        FROM otp_challenges
        WHERE identifier = $1
          AND channel = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [identifier, channel]
    );

    const challenge = otpResult.rows[0];
    if (!challenge) {
      return reply.code(404).send({
        error: channel === "email"
          ? "No OTP challenge found for this email address."
          : "No OTP challenge found for this phone number."
      });
    }

    const failedAttemptsResult = await query(
      `
        SELECT COUNT(*)::int AS failed_count
        FROM otp_challenges
        WHERE identifier = $1
          AND channel = $2
          AND created_at > NOW() - INTERVAL '15 minutes'
          AND verified_at IS NULL
          AND failed_at IS NOT NULL
      `,
      [identifier, channel]
    );

    if ((failedAttemptsResult.rows[0]?.failed_count || 0) >= 5) {
      return reply.code(429).send({ error: "Too many failed attempts. Try again in 15 minutes." });
    }

    const computedHash = hashOtp(identifier, code, channel);
    const computedBuf = Buffer.from(computedHash, "hex");
    const storedBuf = Buffer.from(challenge.otp_hash, "hex");
    const matches = computedBuf.length === storedBuf.length && crypto.timingSafeEqual(computedBuf, storedBuf);
    const challengeExpired = new Date(challenge.expires_at).getTime() < Date.now();
    if (challenge.verified_at || challengeExpired || !matches) {
      await query(
        `
          UPDATE otp_challenges
          SET failed_at = NOW()
          WHERE id = $1
        `,
        [challenge.id]
      );
      return reply.code(401).send({ error: "OTP verification failed." });
    }

    await query(
      `
        UPDATE otp_challenges
        SET verified_at = NOW()
        WHERE id = $1
      `,
      [challenge.id]
    );

    let user = null;

    try {
      user = await upsertVerifiedUser({
        channel,
        identifier,
        phoneNumber: channel === "sms" ? identifier : optionalPhoneNumber,
        email: optionalEmail
      });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({
        error: error.message || "Unable to verify this account right now.",
        ...(error.code ? { code: error.code } : {}),
        ...(error.missing ? { missing: error.missing } : {})
      });
    }

    if (!user) {
      return reply.code(500).send({ error: "Verified account could not be loaded." });
    }

    if (deviceIdentity && publicKey) {
      await query(
        `
          INSERT INTO device_identities (
            device_identity,
            public_key,
            phone_number,
            status,
            last_seen_at,
            revoked_at
          )
          VALUES ($1, $2, $3, 'ACTIVE', NOW(), NULL)
          ON CONFLICT (device_identity)
          DO UPDATE SET
            public_key = EXCLUDED.public_key,
            phone_number = EXCLUDED.phone_number,
            status = 'ACTIVE',
            revoked_at = NULL,
            last_seen_at = NOW(),
            updated_at = NOW()
        `,
        [deviceIdentity, publicKey, user.phone_number]
      );
    }

    return buildVerificationResponse(user, channel, deviceIdentity);
  });
}
