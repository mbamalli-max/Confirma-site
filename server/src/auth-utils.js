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

export function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

export function hashOtp(phoneNumber, code) {
  return crypto.createHash("sha256").update(`${normalizePhoneNumber(phoneNumber)}:${String(code)}`).digest("hex");
}

export function issueAuthToken(phoneNumber, deviceIdentity = "") {
  return jwt.sign(
    {
      phone_number: normalizePhoneNumber(phoneNumber),
      ...(deviceIdentity ? { device_identity: String(deviceIdentity).trim() } : {})
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

export function buildAuthReply(phoneNumber, deviceIdentity = "") {
  const token = issueAuthToken(phoneNumber, deviceIdentity);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    auth_token: token,
    expires_at: expiresAt,
    ...(deviceIdentity ? { device_identity: String(deviceIdentity).trim() } : {})
  };
}

export async function authenticateRequest(request, reply) {
  try {
    const token = getBearerToken(request);
    if (!token) {
      reply.code(401).send({ error: "Missing bearer token." });
      return null;
    }

    const auth = verifyAuthToken(token);
    const headerDeviceIdentity = String(request.headers["x-device-identity"] || "").trim();
    const deviceIdentity = String(auth?.device_identity || headerDeviceIdentity || "").trim();
    if (!deviceIdentity) {
      return auth;
    }

    const deviceResult = await query(
      `
        SELECT phone_number, revoked_at
        FROM device_identities
        WHERE device_identity = $1
        LIMIT 1
      `,
      [deviceIdentity]
    );

    const device = deviceResult.rows[0];
    if (!device || device.phone_number !== auth.phone_number) {
      reply.code(401).send({ error: "Invalid device session." });
      return null;
    }

    if (device.revoked_at) {
      reply.code(401).send({ error: "device_revoked" });
      return null;
    }

    await query(
      `
        UPDATE device_identities
        SET last_seen_at = NOW(), updated_at = NOW()
        WHERE device_identity = $1
      `,
      [deviceIdentity]
    );

    return {
      ...auth,
      device_identity: deviceIdentity
    };
  } catch (error) {
    reply.code(401).send({ error: "Invalid or expired auth token." });
    return null;
  }
}
