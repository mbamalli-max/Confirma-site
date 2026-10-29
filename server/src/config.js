import dotenv from "dotenv";
import crypto from "node:crypto";
import net from "node:net";

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

function normalizeMultilineSecret(rawValue) {
  return String(rawValue || "").replace(/\\n/g, "\n").trim();
}

function canonicalizeVerificationJwk(jwk) {
  return JSON.stringify({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    key_ops: ["verify"],
    ext: true
  });
}

function verificationKeyIdentity(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    key_ops: ["verify"],
    ext: true
  };
  return {
    kid: crypto.createHash("sha256")
      .update(canonicalizeVerificationJwk(publicJwk))
      .digest("hex")
      .slice(0, 16),
    spkiDer: publicKey.export({ type: "spki", format: "der" })
  };
}

function parseUtcTimestamp(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds
  );
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== Number(year)
      || parsed.getUTCMonth() !== Number(month) - 1
      || parsed.getUTCDate() !== Number(day)
      || parsed.getUTCHours() !== Number(hour)
      || parsed.getUTCMinutes() !== Number(minute)
      || parsed.getUTCSeconds() !== Number(second)
      || parsed.getUTCMilliseconds() !== milliseconds) {
    return null;
  }
  return parsed;
}

export function parseServerAttestationRetiredKeys(rawValue, {
  activePrivateKeyPem = "",
  now = new Date()
} = {}) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("SERVER_ATTESTATION_RETIRED_KEYS must be a JSON array.");
  }
  if (!Array.isArray(entries)) {
    throw new Error("SERVER_ATTESTATION_RETIRED_KEYS must be a JSON array.");
  }

  let activeIdentity = null;
  if (activePrivateKeyPem) {
    try {
      const activePrivateKey = crypto.createPrivateKey({ key: activePrivateKeyPem, format: "pem" });
      activeIdentity = verificationKeyIdentity(crypto.createPublicKey(activePrivateKey));
    } catch {
      throw new Error("SERVER_ATTESTATION_PRIVATE_KEY_PEM must contain a valid private key.");
    }
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Attestation key validation requires a valid current time.");
  }
  const earliestRetirement = Date.parse("2026-01-01T00:00:00.000Z");
  const latestRetirement = nowMs + 7 * 24 * 60 * 60 * 1000;
  const seenKids = new Set();

  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each retired attestation key must be an object.");
    }
    const publicKeyPem = normalizeMultilineSecret(entry.public_key_spki_pem);
    if (/PRIVATE KEY/i.test(publicKeyPem)) {
      throw new Error("Retired attestation keys must contain public keys only.");
    }
    if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(publicKeyPem)) {
      throw new Error("Each retired attestation key must contain a valid SPKI public key.");
    }

    let publicKey;
    let identity;
    try {
      publicKey = crypto.createPublicKey({ key: publicKeyPem, format: "pem", type: "spki" });
      if (publicKey.asymmetricKeyType !== "ec"
          || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error("wrong key type");
      }
      identity = verificationKeyIdentity(publicKey);
    } catch {
      throw new Error("Each retired attestation key must be an EC P-256 public key.");
    }

    if (seenKids.has(identity.kid)) {
      throw new Error("Retired attestation key kids must be unique.");
    }
    seenKids.add(identity.kid);
    if (activeIdentity
        && identity.spkiDer.length === activeIdentity.spkiDer.length
        && crypto.timingSafeEqual(identity.spkiDer, activeIdentity.spkiDer)) {
      throw new Error("A retired attestation key must not equal the active key.");
    }
    if (activeIdentity && identity.kid === activeIdentity.kid) {
      throw new Error("Active and retired attestation key kids must be unique.");
    }

    const retiredAt = parseUtcTimestamp(entry.retired_at);
    if (!retiredAt) {
      throw new Error("Each retired attestation key must have a valid ISO 8601 UTC retired_at timestamp.");
    }
    const retiredAtMs = retiredAt.getTime();
    if (retiredAtMs < earliestRetirement) {
      throw new Error("Retired attestation key timestamps must not be before 2026-01-01.");
    }
    if (retiredAtMs > latestRetirement) {
      throw new Error("Retired attestation key timestamps must not be more than 7 days in the future.");
    }

    return {
      public_key_spki_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      retired_at: retiredAt.toISOString(),
      kid: identity.kid
    };
  });
}

function normalizeBaseUrl(rawValue, fallback) {
  const value = String(rawValue || fallback || "").trim();
  return value.replace(/\/+$/, "");
}

function isPlaceholderSecret(value, placeholders = []) {
  const normalizedValue = String(value || "").trim();
  return !normalizedValue || placeholders.includes(normalizedValue);
}

export function resolveTrustProxy(rawValue) {
  if (rawValue === undefined || rawValue === null) return undefined;

  const value = String(rawValue).trim();
  if (!value) return false;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  if (/^\d+$/.test(value)) {
    const hopCount = Number(value);
    return Number.isSafeInteger(hopCount) && hopCount > 0 ? hopCount : false;
  }

  const cidrs = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const valid = cidrs.length && cidrs.every((entry) => {
    const [address, prefixRaw, ...extra] = entry.split("/");
    const version = net.isIP(address);
    const prefix = Number(prefixRaw);
    return !extra.length
      && (version === 4 || version === 6)
      && /^\d+$/.test(prefixRaw || "")
      && Number.isInteger(prefix)
      && prefix >= 0
      && prefix <= (version === 4 ? 32 : 128);
  });
  return valid ? cidrs : null;
}

function parseAdminJwtExpiry(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return { expiresIn: seconds, seconds };
  }

  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|msecs|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const millisecondsPerUnit = unit.startsWith("ms") || unit.startsWith("millisecond")
    ? 1
    : (unit === "s" || unit.startsWith("sec") || unit.startsWith("second"))
      ? 1_000
      : (unit === "m" || unit.startsWith("min"))
        ? 60_000
        : (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour"))
          ? 3_600_000
          : 86_400_000;
  const seconds = Math.floor((amount * millisecondsPerUnit) / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return { expiresIn: value, seconds };
}

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
  databaseUrl: normalizeDatabaseUrl(process.env.DATABASE_URL),
  databaseSsl: String(process.env.DATABASE_SSL || "false") === "true",
  jwtSecret: process.env.JWT_SECRET || "",
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || "",
  adminTotpEncKey: process.env.ADMIN_TOTP_ENC_KEY || "",
  adminTotpEncKeyBytes: null,
  adminJwtExpiry: process.env.ADMIN_JWT_EXPIRY || "1h",
  adminCorsOrigins: process.env.ADMIN_CORS_ORIGINS || "",
  adminIpAllowlist: process.env.ADMIN_IP_ALLOWLIST || "",
  adminKAnonThreshold: process.env.ADMIN_K_ANON_THRESHOLD === undefined
    ? 5
    : Number(process.env.ADMIN_K_ANON_THRESHOLD),
  trustProxyRaw: process.env.TRUST_PROXY,
  trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),
  serverReceiptSecret: process.env.SERVER_RECEIPT_SECRET || "",
  serverAttestationPrivateKeyPem: normalizeMultilineSecret(
    process.env.SERVER_ATTESTATION_PRIVATE_KEY_PEM || process.env.SERVER_ATTESTATION_PRIVATE_KEY || ""
  ),
  serverAttestationRetiredKeysRaw: String(process.env.SERVER_ATTESTATION_RETIRED_KEYS || "").trim(),
  serverAttestationRetiredKeys: [],
  jwtExpiry: process.env.JWT_EXPIRY || "30d",
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpRateLimitPerHour: Number(process.env.OTP_RATE_LIMIT_PER_HOUR || 50),
  otpDefaultChannel: normalizeOtpChannel(process.env.OTP_DEFAULT_CHANNEL || "email"),
  allowDevOtp: String(process.env.ALLOW_DEV_OTP || "false") === "true",
  smsProviderEnabled: String(process.env.SMS_PROVIDER_ENABLED || "false") === "true",
  resendApiKey: String(process.env.RESEND_API_KEY || "").trim(),
  resendFromEmail: String(process.env.RESEND_FROM_EMAIL || "Konfirmata <noreply@konfirmata.com>").trim(),
  verifyBaseUrl: normalizeBaseUrl(process.env.VERIFY_BASE_URL, "https://konfirmata.com"),
  verificationKeyUrl: normalizeBaseUrl(process.env.VERIFICATION_KEY_URL, "")
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

export function getAdminJwtExpiry() {
  return parseAdminJwtExpiry(config.adminJwtExpiry);
}

export function getProxyTrustSummary() {
  if (config.trustProxy === undefined) return { proxy_trust: "unset" };
  if (config.trustProxy === false) return { proxy_trust: "disabled" };
  if (config.trustProxy === null) return { proxy_trust: "invalid" };
  if (typeof config.trustProxy === "number") {
    return { proxy_trust: "hop-count", trusted_hops: config.trustProxy };
  }
  return { proxy_trust: "cidr-list", trusted_proxy_rules: config.trustProxy.length };
}

export function validateRuntimeConfig() {
  const errors = [];
  const warnings = [];
  const strictMode = config.nodeEnv === "production";
  const jwtSecretMissing = !config.jwtSecret;
  const receiptSecretMissing = !config.serverReceiptSecret;
  const adminJwtExpiry = getAdminJwtExpiry();
  const adminKAnonThresholdValid = Number.isInteger(config.adminKAnonThreshold)
    && config.adminKAnonThreshold >= 5;

  try {
    config.serverAttestationRetiredKeys = parseServerAttestationRetiredKeys(
      config.serverAttestationRetiredKeysRaw,
      { activePrivateKeyPem: config.serverAttestationPrivateKeyPem }
    );
  } catch (error) {
    config.serverAttestationRetiredKeys = [];
    if (strictMode) errors.push(error.message);
    else warnings.push(error.message);
  }

  const adminTotpKeyRaw = String(config.adminTotpEncKey || "");
  const adminTotpKeyValid = /^[0-9a-fA-F]{64}$/.test(adminTotpKeyRaw)
    && Buffer.from(adminTotpKeyRaw, "hex").length === 32;
  config.adminTotpEncKeyBytes = adminTotpKeyValid
    ? Buffer.from(adminTotpKeyRaw, "hex")
    : null;

  if (!config.jwtSecret) {
    errors.push("JWT_SECRET environment variable is required");
  }

  if (!config.serverReceiptSecret) {
    errors.push("SERVER_RECEIPT_SECRET environment variable is required");
  }

  if (strictMode && Buffer.byteLength(String(config.adminJwtSecret || ""), "utf8") < 32) {
    errors.push("ADMIN_JWT_SECRET must be at least 32 bytes in production");
  }

  if (strictMode && config.adminJwtSecret === config.jwtSecret) {
    errors.push("ADMIN_JWT_SECRET must be different from JWT_SECRET in production");
  }

  if (strictMode && !adminTotpKeyValid) {
    errors.push("ADMIN_TOTP_ENC_KEY must be exactly 64 hexadecimal characters (32 decoded bytes) in production");
  }

  if (!adminJwtExpiry) {
    errors.push("ADMIN_JWT_EXPIRY must be a positive duration such as 1h, 60m, 3600s, or 3600");
  } else if (adminJwtExpiry.seconds > 3_600) {
    errors.push("ADMIN_JWT_EXPIRY must not exceed 1 hour");
  }

  if (!adminKAnonThresholdValid) {
    errors.push("ADMIN_K_ANON_THRESHOLD must be an integer of at least 5");
  }

  if (strictMode && String(config.adminIpAllowlist || "").trim() && !config.trustProxy) {
    errors.push("ADMIN_IP_ALLOWLIST requires an enabled TRUST_PROXY configuration in production");
  }

  if (config.trustProxy === null) {
    errors.push("TRUST_PROXY must be false, a positive hop count, or a comma-separated CIDR list; bare true is not allowed");
  }

  if (strictMode && !config.serverAttestationPrivateKeyPem) {
    errors.push("SERVER_ATTESTATION_PRIVATE_KEY_PEM environment variable is required in production for offline attestation verification.");
  }

  if (!strictMode && !config.serverAttestationPrivateKeyPem) {
    warnings.push("SERVER_ATTESTATION_PRIVATE_KEY_PEM is not set; development attestation signatures will use an ephemeral in-memory key.");
  }

  if (config.smsProviderEnabled) {
    errors.push("SMS_PROVIDER_ENABLED=true, but no SMS provider integration is configured in this build. Disable SMS_PROVIDER_ENABLED until SMS delivery is implemented.");
  }

  if (!config.allowDevOtp) {
    if (!config.resendApiKey) {
      errors.push("RESEND_API_KEY is required when email OTP is enabled without development fallback.");
    }
    if (isPlaceholderSecret(config.resendFromEmail, [
      "Konfirmata <noreply@konfirmata.com>",
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
    const error = new Error(`Config validation failed:\n- ${errors.join("\n- ")}`);
    error.fatal = jwtSecretMissing || receiptSecretMissing || strictMode
      || config.trustProxy === null || !adminKAnonThresholdValid;
    throw error;
  }
}

export function createCorsDelegator(allowedOrigins) {
  return () => (request, callback) => {
    const isAdmin = String(request.url || "").startsWith("/admin");
    const adminOrigins = String(config.adminCorsOrigins || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    callback(null, {
      origin: isAdmin ? (adminOrigins.length ? adminOrigins : false) : allowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Device-Identity"],
      credentials: false
    });
  };
}
