import dotenv from "dotenv";

dotenv.config();

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (value.startsWith("railwaypostgresql://")) {
    return `postgresql://${value.slice("railwaypostgresql://".length)}`;
  }
  return value;
}

function normalizeOtpChannel(rawValue) {
  return String(rawValue || "").trim().toLowerCase() === "sms" ? "sms" : "email";
}

function isPlaceholderSecret(value, placeholders = []) {
  const normalizedValue = String(value || "").trim();
  return !normalizedValue || placeholders.includes(normalizedValue);
}

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  host: process