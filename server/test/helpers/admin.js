import { effectiveSector } from "../../src/sector-assignment.js";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  encryptTotpSecret,
  generateTotpSecret,
  hashAdminPassword,
  issueAdminToken,
  requireAdmin
} from "../../src/admin-auth-utils.js";
import { config, createCorsDelegator } from "../../src/config.js";
import { query } from "../../src/db.js";
import { registerAdminAuthRoutes } from "../../src/routes/admin/auth.js";
import { registerAdminClassificationRoutes } from "../../src/routes/admin/classification.js";
import { registerAdminMetricsRoutes } from "../../src/routes/admin/metrics.js";
import { registerAdminSuppressedRoutes } from "../../src/routes/admin/suppressed.js";

export const PUBLIC_ORIGINS = ["https://konfirmata.com", "https://www.konfirmata.com"];
export const ADMIN_ORIGIN = "https://admin.example.test";
export const TEST_ADMIN_PASSWORD = crypto.randomBytes(24).toString("base64url");

let testPasswordHash;
let testTotpSecretEnc;

export function assertDisposableTestDatabase(databaseUrl = config.databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl));
  } catch {
    throw new Error("Admin database tests require a disposable local test database.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^postgres(ql)?:$/.test(parsed.protocol)
      || !localHosts.has(parsed.hostname)
      || databaseName.includes("/")
      || !databaseName.endsWith("_test")) {
    throw new Error("Admin database tests require a disposable local test database.");
  }
}

export async function prepareAdminTestDatabase({
  migrations,
  databaseUrl = config.databaseUrl,
  executor = query
}) {
  assertDisposableTestDatabase(databaseUrl);
  for (const migrationUrl of migrations) {
    const sql = await readFile(migrationUrl, "utf8");
    await executor(sql);
  }
}

export async function buildApp({ trustProxy, logger = false } = {}) {
  const app = Fastify({
    logger,
    ...(trustProxy === undefined ? {} : { trustProxy })
  });
  await app.register(cors, createCorsDelegator(PUBLIC_ORIGINS));
  await app.register(rateLimit, { global: false });
  app.get("/health", async () => ({ status: "ok" }));
  await registerAdminAuthRoutes(app);
  await registerAdminClassificationRoutes(app);
  await registerAdminMetricsRoutes(app);
  await registerAdminSuppressedRoutes(app);
  app.get("/admin/owner-only", { preHandler: requireAdmin(["owner"]) }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

async function getTestCredentials() {
  if (!testPasswordHash) {
    testPasswordHash = await hashAdminPassword(TEST_ADMIN_PASSWORD);
    testTotpSecretEnc = encryptTotpSecret(generateTotpSecret());
  }
  return { passwordHash: testPasswordHash, totpSecretEnc: testTotpSecretEnc };
}

export async function seedAdmin(role = "viewer") {
  const credentials = await getTestCredentials();
  const email = `admin-${crypto.randomUUID()}@example.test`;
  const result = await query(
    `
      INSERT INTO admin_users (email, password_hash, totp_secret_enc, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, role
    `,
    [email, credentials.passwordHash, credentials.totpSecretEnc, role]
  );
  return result.rows[0];
}

export async function createSession(adminUser, expiry = config.adminJwtExpiry) {
  const previousExpiry = config.adminJwtExpiry;
  config.adminJwtExpiry = expiry;
  const jti = crypto.randomUUID();
  const token = issueAdminToken(adminUser, jti);
  config.adminJwtExpiry = previousExpiry;
  const decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  await query(
    `INSERT INTO admin_sessions (jti, admin_user_id, expires_at) VALUES ($1, $2, $3)`,
    [jti, adminUser.id, new Date(Math.max(Date.now() + 60_000, Number(decoded.exp) * 1000))]
  );
  return { token, jti };
}

export async function rejectAuditInserts(run) {
  await query(`
    ALTER TABLE admin_audit_log
    ADD CONSTRAINT admin_audit_test_reject_insert CHECK (false) NOT VALID
  `);
  try {
    await run();
  } finally {
    await query(`
      ALTER TABLE admin_audit_log
      DROP CONSTRAINT admin_audit_test_reject_insert
    `);
  }
}

// The sector columns a profile holds once migration 017 has run: the same rule the server applies
// (catalog, the person's sector, or "Other business" as a fallback; none without a business profile).
export function storedSectorColumns({ businessType = null, sector = null, businessDescription = null }) {
  const assigned = effectiveSector({ business_type_id: businessType, sector_id: sector, business_description: businessDescription });
  return assigned ? [assigned.sectorId, assigned.source] : [null, null];
}
