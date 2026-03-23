import dotenv from "dotenv";

dotenv.config();

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787),
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: String(process.env.DATABASE_SSL || "false") === "true",
  jwtSecret: process.env.JWT_SECRET || "confirma-dev-jwt-secret",
  serverReceiptSecret: process.env.SERVER_RECEIPT_SECRET || process.env.JWT_SECRET || "confirma-dev-receipt-secret",
  jwtExpiry: process.env.JWT_EXPIRY || "30d",
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpRateLimitPerHour: Number(process.env.OTP_RATE_LIMIT_PER_HOUR || 5),
  allowDevOtp: String(process.env.ALLOW_DEV_OTP || "true") === "true"
};
