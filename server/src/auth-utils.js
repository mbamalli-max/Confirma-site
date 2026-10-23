import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { query } from "./db.js";

export function normalizePhoneNumber(phoneNumber) {
  return String(phoneNumber || "").trim();
}

export function isValidPhoneNumber(phoneNumber) {
  return /^\+?[\d\s\-]{7,15}$/.test(normalizePhoneNumber(phoneNumber));
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function normalizeOtpChannel(channel) {
  return String(channel || "").trim().toLowerCase() === "sms" ? "sms" : "email";
}

export function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

export function hashOtp(identifier, code, channel = "email") {
  const normalizedChannel = normalizeOtpChannel(channel);
  const normalizedIdentifier = normalizedChannel === "sms"
    ? normalizePhoneNumber(identifier)
    : normalizeEmail(identifier);
  return crypto.createHash("sha256").update(`${normalizedChannel}:${normalizedIdentifier}:${String(code)}`).digest("hex");
}

export function issueAuthToken(phoneNumber, deviceIdentity = "", extraClaims = {}) {
  return jwt.sign(
    {
      phone_number: normalizePhoneNumber(phoneNumber),
      ...(deviceIdentity ? { device_identity: String(deviceIdentity).trim() } : {}),
      ...extraClaims
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiry
    }
  );
}

export function verifyAuthToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) return "";
  return value;
}

export function buildReceiptSignature(parts) {
  return crypto.createHmac("sha256", config.serverReceiptSecret).update(parts.join("||")).digest("hex");
}

export function buildAuthReply(phoneNumber, deviceIdentity = "", extraClaims = {}) {
  const token = issueAuthToken(phoneNumber, deviceIdentity, extraClaims);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    auth_token: token,
    expires_at: expiresAt,
    ...(deviceIdentity ? { device_identity: String(deviceIdentity).trim() } : {})
  };
}

export const INVALID_SESSION_REPLY = { error: "session_invalid" };
export const MISSING_TOKEN_REPLY = { error: "token_missing" };
export const DEVICE_MISMATCH_REPLY = { error: "device_mismatch" };
export const AUTH_UNAVAILABLE_REPLY = { error: "auth_unavailable" };

export async function authenticateRequest(request, reply) {
  const token = getBearerToken(request);
  if (!token) {
    reply.code(401).send(MISSING_TOKEN_REPLY);
    return null;
  }

  let auth;
  try {
    auth = verifyAuthToken(token);
  } catch {
    reply.code(401).send(INVALID_SESSION_REPLY);
    return null;
  }

  const sessionId = String(auth?.sid || "").trim();
  if (!sessionId) {
    reply.code(401).send(INVALID_SESSION_REPLY);
    return null;
  }

  let session;
  try {
    const sessionResult = await query(
      `
        SELECT
          s.device_identity,
          s.revoked_at,
          u.id AS account_id,
          u.phone_number,
          d.phone_number AS device_phone_number,
          d.revoked_at AS device_revoked_at
        FROM user_sessions s
        INNER JOIN users u
          ON u.id = s.user_id
        LEFT JOIN device_identities d
          ON d.device_identity = s.device_identity
        WHERE s.id = $1
        LIMIT 1
      `,
      [sessionId]
    );
    session = sessionResult.rows[0];
  } catch {
    reply.code(503).send(AUTH_UNAVAILABLE_REPLY);
    return null;
  }

  if (!session
      || session.revoked_at
      || session.phone_number !== auth.phone_number
      || !session.device_identity
      || session.device_phone_number !== auth.phone_number
      || session.device_revoked_at) {
    reply.code(401).send(INVALID_SESSION_REPLY);
    return null;
  }

  const headerDeviceIdentity = String(request.headers["x-device-identity"] || "").trim();
  if (headerDeviceIdentity !== session.device_identity) {
    reply.code(401).send(DEVICE_MISMATCH_REPLY);
    return null;
  }

  try {
    await query(
      `
        UPDATE user_sessions
        SET last_seen_at = NOW()
        WHERE id = $1
      `,
      [sessionId]
    );

    await query(
      `
        UPDATE device_identities
        SET last_seen_at = NOW(), updated_at = NOW()
        WHERE device_identity = $1
      `,
      [session.device_identity]
    );
  } catch {
    reply.code(503).send(AUTH_UNAVAILABLE_REPLY);
    return null;
  }

  return {
    ...auth,
    account_id: session.account_id,
    device_identity: session.device_identity
  };
}
