import { config } from "../config.js";
import { query } from "../db.js";
import {
  buildAuthReply,
  generateOtpCode,
  hashOtp,
  isValidPhoneNumber,
  normalizePhoneNumber
} from "../auth-utils.js";

export async function registerAuthRoutes(app) {
  app.post("/auth/otp/request", async (request, reply) => {
    const phoneNumber = normalizePhoneNumber(request.body?.phone_number);
    if (!isValidPhoneNumber(phoneNumber)) {
      return reply.code(400).send({ error: "Enter a valid phone number." });
    }

    const rateLimitResult = await query(
      `
        SELECT COUNT(*)::int AS request_count
        FROM otp_challenges
        WHERE phone_number = $1
          AND created_at > NOW() - INTERVAL '1 hour'
      `,
      [phoneNumber]
    );

    if ((rateLimitResult.rows[0]?.request_count || 0) >= config.otpRateLimitPerHour) {
      return reply.code(429).send({ error: "OTP request limit reached for this phone number." });
    }

    const code = generateOtpCode();
    const otpHash = hashOtp(phoneNumber, code);

    await query(
      `
        INSERT INTO otp_challenges (phone_number, otp_hash, expires_at)
        VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)
      `,
      [phoneNumber, otpHash, String(config.otpTtlMinutes)]
    );

    return {
      ok: true,
      ttl_minutes: config.otpTtlMinutes,
      delivery: config.allowDevOtp ? "development" : "sms",
      ...(config.allowDevOtp ? { dev_code: code } : {})
    };
  });

  app.post("/auth/otp/verify", async (request, reply) => {
    const phoneNumber = normalizePhoneNumber(request.body?.phone_number);
    const code = String(request.body?.code || "").trim();
    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const publicKey = String(request.body?.public_key || "").trim();

    if (!isValidPhoneNumber(phoneNumber) || !/^\d{6}$/.test(code)) {
      return reply.code(400).send({ error: "Phone number and 6-digit code are required." });
    }

    if ((deviceIdentity && !publicKey) || (!deviceIdentity && publicKey)) {
      return reply.code(400).send({ error: "device_identity and public_key must be provided together." });
    }

    const otpResult = await query(
      `
        SELECT id, otp_hash, expires_at, verified_at
        FROM otp_challenges
        WHERE phone_number = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [phoneNumber]
    );

    const challenge = otpResult.rows[0];
    if (!challenge) {
      return reply.code(404).send({ error: "No OTP challenge found for this phone number." });
    }

    const challengeExpired = new Date(challenge.expires_at).getTime() < Date.now();
    if (challenge.verified_at || challengeExpired || hashOtp(phoneNumber, code) !== challenge.otp_hash) {
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

    await query(
      `
        INSERT INTO users (phone_number)
        VALUES ($1)
        ON CONFLICT (phone_number) DO NOTHING
      `,
      [phoneNumber]
    );

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
        [deviceIdentity, publicKey, phoneNumber]
      );
    }

    return {
      ok: true,
      phone_number: phoneNumber,
      ...buildAuthReply(phoneNumber, deviceIdentity)
    };
  });
}
