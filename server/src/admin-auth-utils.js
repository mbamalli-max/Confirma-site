import crypto from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { config, getAdminJwtExpiry } from "./config.js";
import { query } from "./db.js";

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function getTotpEncryptionKey() {
  if (Buffer.isBuffer(config.adminTotpEncKeyBytes) && config.adminTotpEncKeyBytes.length === 32) {
    return config.adminTotpEncKeyBytes;
  }

  const raw = String(config.adminTotpEncKey || "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("ADMIN_TOTP_ENC_KEY must be exactly 64 hexadecimal characters.");
  }

  const decoded = Buffer.from(raw, "hex");
  if (decoded.length !== 32) {
    throw new Error("ADMIN_TOTP_ENC_KEY must decode to exactly 32 bytes.");
  }

  config.adminTotpEncKeyBytes = decoded;
  return config.adminTotpEncKeyBytes;
}

function decodeBase32(value) {
  const normalized = String(value || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[\s-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) return null;

  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  return Buffer.from(bytes);
}

function encodeBase32(buffer) {
  let bits = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of buffer) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += BASE32_ALPHABET[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) {
    output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  }
  return output;
}

function totpForCounter(secretBytes, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secretBytes).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(String(password), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derivedKey.toString("hex")
  ].join("$");
}

export async function verifyAdminPassword(password, storedHash) {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltHex, hashHex, ...extra] = String(storedHash || "").split("$");
    if (scheme !== "scrypt" || extra.length || !/^[0-9a-f]+$/i.test(saltHex)
        || !/^[0-9a-f]+$/i.test(hashHex) || saltHex.length !== 32 || hashHex.length !== 128) {
      return false;
    }

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isSafeInteger(N) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0
        || !Number.isSafeInteger(r) || r < 1 || r > 32
        || !Number.isSafeInteger(p) || p < 1 || p > 16) {
      return false;
    }

    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptAsync(String(password), Buffer.from(saltHex, "hex"), expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAX_MEMORY, (128 * N * r) + (1024 * 1024))
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getTotpEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["aes-256-gcm", iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join("$");
}

export function decryptTotpSecret(encrypted) {
  const [scheme, ivHex, authTagHex, ciphertextHex, ...extra] = String(encrypted || "").split("$");
  if (scheme !== "aes-256-gcm" || extra.length
      || !/^[0-9a-f]{24}$/i.test(ivHex)
      || !/^[0-9a-f]{32}$/i.test(authTagHex)
      || !/^[0-9a-f]*$/i.test(ciphertextHex)
      || ciphertextHex.length % 2 !== 0) {
    throw new Error("Invalid encrypted TOTP secret format.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getTotpEncryptionKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function verifyTotp(secret, token, now = Date.now()) {
  const secretBytes = decodeBase32(secret);
  const supplied = String(token || "");
  if (!secretBytes?.length || !/^\d{6}$/.test(supplied)) return false;

  const suppliedBuffer = Buffer.from(supplied, "ascii");
  const counter = Math.floor(Number(now) / 30_000);
  let matched = false;
  for (const offset of [-1, 0, 1]) {
    const candidateCounter = counter + offset;
    if (candidateCounter < 0) continue;
    const candidate = Buffer.from(totpForCounter(secretBytes, candidateCounter), "ascii");
    matched = crypto.timingSafeEqual(suppliedBuffer, candidate) || matched;
  }
  return matched;
}

export function issueAdminToken(adminUser, jti) {
  const expiry = getAdminJwtExpiry();
  if (!expiry || expiry.seconds > 3_600) {
    throw new Error("ADMIN_JWT_EXPIRY must be a valid duration no longer than 1 hour.");
  }
  return jwt.sign(
    {
      sub: String(adminUser.id),
      role: String(adminUser.role),
      jti: String(jti)
    },
    config.adminJwtSecret,
    {
      algorithm: "HS256",
      expiresIn: expiry.expiresIn
    }
  );
}

export function verifyAdminToken(token) {
  return jwt.verify(token, config.adminJwtSecret, { algorithms: ["HS256"] });
}

export function requireAdmin(roles = []) {
  const allowedRoles = new Set(roles.map((role) => String(role)));
  return async function adminPreHandler(request, reply) {
    try {
      const authorization = String(request.headers.authorization || "");
      const match = authorization.match(/^Bearer\s+(\S+)$/i);
      if (!match) {
        return reply.code(401).send({ error: "Missing or invalid admin bearer token." });
      }

      const claims = verifyAdminToken(match[1]);
      if (!claims?.sub || !claims?.jti) {
        return reply.code(401).send({ error: "Invalid or expired admin token." });
      }

      const result = await query(
        `
          SELECT au.id, au.email, au.role
          FROM admin_sessions session
          INNER JOIN admin_users au ON au.id = session.admin_user_id
          WHERE session.jti = $1
            AND session.admin_user_id = $2
            AND session.revoked_at IS NULL
            AND session.expires_at > NOW()
            AND au.status = 'ACTIVE'
          LIMIT 1
        `,
        [String(claims.jti), String(claims.sub)]
      );
      const adminUser = result.rows[0];
      if (!adminUser) {
        return reply.code(401).send({ error: "Invalid or expired admin session." });
      }

      if (allowedRoles.size && !allowedRoles.has(adminUser.role)) {
        return reply.code(403).send({ error: "Insufficient admin role." });
      }

      request.adminUser = {
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        jti: String(claims.jti)
      };
    } catch {
      return reply.code(401).send({ error: "Invalid or expired admin token." });
    }
  };
}

export async function writeAuditRow({
  adminUserId = null,
  action,
  subjectType = null,
  subjectId = null,
  reason = null,
  request = null,
  responseStatus = null
}, executor = query) {
  const execute = typeof executor === "function"
    ? executor
    : executor.query.bind(executor);
  await execute(
    `
      INSERT INTO admin_audit_log (
        admin_user_id, action, subject_type, subject_id, reason,
        request_ip, user_agent, response_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      adminUserId,
      String(action),
      subjectType,
      subjectId,
      reason,
      request?.ip || null,
      request?.headers?.["user-agent"] || null,
      responseStatus
    ]
  );
}
