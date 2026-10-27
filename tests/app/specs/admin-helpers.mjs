import crypto from "node:crypto";
import { createRequire } from "node:module";
import { assertLocalDatabaseUrl } from "../scripts/local-only.mjs";

// The tests package has no Postgres client; use the server's, as the server code does.
const pg = createRequire(new URL("../../../server/package.json", import.meta.url))("pg");

// Duplicated from tests/app/scripts/serve-api.mjs (keep in sync).
export const ADMIN_JWT_SECRET = "local-app-playwright-admin-jwt-secret-0123456789abcdef";
export const ADMIN_TOTP_ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
export const API_BASE = "http://127.0.0.1:8787";
export const ADMIN_EMAIL = "owner@example.test";
export const ADMIN_PASSWORD = crypto.randomBytes(24).toString("base64url");

process.env.ADMIN_JWT_SECRET ||= ADMIN_JWT_SECRET;
process.env.ADMIN_TOTP_ENC_KEY ||= ADMIN_TOTP_ENC_KEY;

const utils = () => import("../../../server/src/admin-auth-utils.js");

export async function withDb(run) {
  const database = assertLocalDatabaseUrl(process.env.APP_TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: database.toString() });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

export async function seedOwner() {
  const { hashAdminPassword, encryptTotpSecret, generateTotpSecret } = await utils();
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashAdminPassword(ADMIN_PASSWORD);
  const totpSecretEnc = encryptTotpSecret(totpSecret);
  const row = await withDb(async (db) => {
    await db.query("DELETE FROM admin_users WHERE email = $1", [ADMIN_EMAIL]);
    const result = await db.query(
      "INSERT INTO admin_users (email, password_hash, totp_secret_enc, role) VALUES ($1, $2, $3, 'owner') RETURNING id, email, role",
      [ADMIN_EMAIL, passwordHash, totpSecretEnc]
    );
    return result.rows[0];
  });
  return { ...row, password: ADMIN_PASSWORD, totpSecret };
}

// Copied from server/test/helpers/admin.js.
export function totpToken(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.replace(/=+$/g, "");
  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    bits = (bits << 5) | alphabet.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function routeAdminConfig(page) {
  await page.route("**/admin/config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export const API_BASE = "${API_BASE}";\nexport const LOGOUT_TIMEOUT_MS = 1500;`
  }));
}
