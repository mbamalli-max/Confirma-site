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
      expiresI