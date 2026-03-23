import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

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

export function issueAuthToken(phoneNumber) {
  return jwt.sign(
    {
      phone_number: normalizePhoneNumber(phoneNumber)
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

export function buildAuthReply(phoneNumber) {
  const token = issueAuthToken(phoneNumber);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    auth_token: token,
    expires_at: expiresAt
  };
}
