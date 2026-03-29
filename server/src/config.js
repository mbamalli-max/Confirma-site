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
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787),
  databaseUrl: normalizeDatabaseUrl(process.env.DATABASE_URL),
  databaseSsl: String(process.env.DATABASE_SSL || "false") === "true",
  jwtSecret: process.env.JWT_SECRET || "confirma-dev-jwt-secret",
  serverReceiptSecret: process.env.SERVER_RECEIPT_SECRET || process.env.JWT_SECRET || "confirma-dev-receipt-secret",
  jwtExpiry: process.env.JWT_EXPIRY || "30d",
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpRateLimitPerHour: Number(process.env.OTP_RATE_LIMIT_PER_HOUR || 5),
  otpDefaultChannel: normalizeOtpChannel(process.env.OTP_DEFAULT_CHANNEL || "email"),
  allowDevOtp: String(process.env.ALLOW_DEV_OTP || "true") === "true",
  smsProviderEnabled: String(process.env.SMS_PROVIDER_ENABLED || "false") === "true",
  resendApiKey: String(process.env.RESEND_API_KEY || "").trim(),
  resendFromEmail: String(process.env.RESEND_FROM_EMAIL || "Confirma <noreply@your-verified-domain.com>").trim()
};

export function getAuthDeliverySummary() {
  return {
    otp_default_channel: config.otpDefaultChannel,
    sms_provider_enabled: config.smsProviderEnabled,
    email_delivery: config.resendApiKey
      ? "resend"
      : (config.allowDevOtp ? "development-fallback" : "missing"),
    dev_otp_enabled: config.allowDevOtp
  };
}

export function validateRuntimeConfig() {
  const errors = [];
  const warnings = [];
  const strictMode = config.nodeEnv === "production";

  const jwtPlaceholder = isPlaceholderSecret(config.jwtSecret, [
    "confirma-dev-jwt-secret",
    "replace-this-with-a-long-random-secret"
  ]);
  const receiptPlaceholder = isPlaceholderSecret(config.serverReceiptSecret, [
    "confirma-dev-receipt-secret",
    "replace-this-with-a-second-long-random-secret"
  ]);

  if (jwtPlaceholder) {
    (strictMode ? errors : warnings).push("JWT_SECRET is still using a development placeholder.");
  }

  if (receiptPlaceholder) {
    (strictMode ? errors : warnings).push("SERVER_RECEIPT_SECRET is still using a development placeholder.");
  }

  if (config.smsProviderEnabled) {
    errors.push("SMS_PROVIDER_ENABLED=true, but no SMS provider integration is configured in this build. Disable SMS_PROVIDER_ENABLED until SMS delivery is implemented.");
  }

  if (strictMode || !config.allowDevOtp) {
    if (!config.resendApiKey) {
      errors.push("RESEND_API_KEY is required when email OTP is enabled without development fallback.");
    }
    if (isPlaceholderSecret(config.resendFromEmail, [
      "Confirma <auth@confirma.app>",
      "Confirma <noreply@your-verified-domain.com>"
    ])) {
      errors.push("RESEND_FROM_EMAIL must be set to a verified sender address when email OTP delivery is enabled.");
    }
  }

  if (warnings.length) {
    console.warn(`Config warnings:\n- ${warnings.join("\n- ")}`);
  }

  if (errors.length) {
    throw new Error(`Config validation failed:\n- ${errors.join("\n- ")}`);
  }
}
