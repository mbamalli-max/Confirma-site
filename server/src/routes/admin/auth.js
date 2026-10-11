import crypto from "node:crypto";
import net from "node:net";
import { config } from "../../config.js";
import { query, withTransaction } from "../../db.js";
import {
  decryptTotpSecret,
  issueAdminToken,
  requireAdmin,
  verifyAdminPassword,
  verifyTotp,
  writeAuditRow
} from "../../admin-auth-utils.js";

function ipv4ToBigInt(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address) {
  let value = String(address || "").toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = ipv4ToBigInt(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function parseIp(address) {
  let normalized = String(address || "").trim();
  if (normalized.startsWith("::ffff:") && net.isIP(normalized.slice(7)) === 4) {
    normalized = normalized.slice(7);
  }
  const version = net.isIP(normalized);
  if (version === 4) return { version, bits: 32, value: ipv4ToBigInt(normalized) };
  if (version === 6) return { version, bits: 128, value: ipv6ToBigInt(normalized) };
  return null;
}

function ipMatchesRule(address, rule) {
  const [networkRaw, prefixRaw, ...extra] = String(rule || "").split("/");
  if (extra.length) return false;
  const addressValue = parseIp(address);
  const networkValue = parseIp(networkRaw);
  if (!addressValue || !networkValue || addressValue.version !== networkValue.version) return false;
  if (prefixRaw === undefined) return addressValue.value === networkValue.value;

  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > addressValue.bits) return false;
  const shift = BigInt(addressValue.bits - prefix);
  return (addressValue.value >> shift) === (networkValue.value >> shift);
}

export async function enforceAdminIpAllowlist(request, reply) {
  const rules = String(config.adminIpAllowlist || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (!rules.length) return;
  if (!rules.some((rule) => ipMatchesRule(request.ip, rule))) {
    return reply.code(403).send({ error: "Admin access is not allowed from this IP address." });
  }
}

async function recordLoginFailure(adminUser, request, reason) {
  await withTransaction(async (client) => {
    if (adminUser?.id) {
      await client.query(
        `
          UPDATE admin_users
          SET
            failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= 10 THEN NOW() + INTERVAL '15 minutes'
              ELSE locked_until
            END,
            updated_at = NOW()
          WHERE id = $1
        `,
        [adminUser.id]
      );
    }

    await writeAuditRow({
      adminUserId: adminUser?.id || null,
      action: "admin.login.failure",
      subjectType: adminUser?.id ? "admin_user" : null,
      subjectId: adminUser?.id || null,
      reason,
      request,
      responseStatus: 401
    }, client);
  });
}

export async function registerAdminAuthRoutes(app) {
  app.addHook("onSend", async (request, reply, payload) => {
    if (String(request.url || "").startsWith("/admin")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.post("/admin/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    preHandler: enforceAdminIpAllowlist
  }, async (request, reply) => {
    const body = request.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const totp = String(body.totp || "");
    if (!email || !password || !totp) {
      return reply.code(400).send({ error: "Email, password, and TOTP are required." });
    }

    const result = await query(
      `
        SELECT id, email, password_hash, totp_secret_enc, role, status,
               failed_login_count, locked_until
        FROM admin_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [email]
    );
    const adminUser = result.rows[0] || null;

    if (!adminUser || adminUser.status !== "ACTIVE") {
      await recordLoginFailure(adminUser, request, "invalid_credentials");
      return reply.code(401).send({ error: "Invalid admin credentials." });
    }

    if (adminUser.locked_until && new Date(adminUser.locked_until).getTime() > Date.now()) {
      await writeAuditRow({
        adminUserId: adminUser.id,
        action: "admin.login.failure",
        subjectType: "admin_user",
        subjectId: adminUser.id,
        reason: "account_locked",
        request,
        responseStatus: 401
      });
      return reply.code(401).send({ error: "Invalid admin credentials." });
    }

    const passwordValid = await verifyAdminPassword(password, adminUser.password_hash);
    let totpValid = false;
    if (passwordValid) {
      try {
        totpValid = verifyTotp(decryptTotpSecret(adminUser.totp_secret_enc), totp);
      } catch {
        totpValid = false;
      }
    }

    if (!passwordValid || !totpValid) {
      await recordLoginFailure(adminUser, request, "invalid_credentials");
      return reply.code(401).send({ error: "Invalid admin credentials." });
    }

    const jti = crypto.randomUUID();
    const token = issueAdminToken(adminUser, jti);
    const decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const expiresAt = new Date(Number(decoded.exp) * 1000);

    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO admin_sessions (jti, admin_user_id, expires_at, ip, user_agent)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [jti, adminUser.id, expiresAt, request.ip || null, request.headers["user-agent"] || null]
      );
      await client.query(
        `
          UPDATE admin_users
          SET failed_login_count = 0, locked_until = NULL,
              last_login_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `,
        [adminUser.id]
      );
      await writeAuditRow({
        adminUserId: adminUser.id,
        action: "admin.login.success",
        subjectType: "admin_user",
        subjectId: adminUser.id,
        request,
        responseStatus: 200
      }, client);
    });

    return reply.send({ token, expires_at: expiresAt.toISOString() });
  });

  app.post("/admin/auth/logout", {
    preHandler: [enforceAdminIpAllowlist, requireAdmin()]
  }, async (request, reply) => {
    await withTransaction(async (client) => {
      await client.query(
        `
          UPDATE admin_sessions
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE jti = $1 AND admin_user_id = $2
        `,
        [request.adminUser.jti, request.adminUser.id]
      );
      await writeAuditRow({
        adminUserId: request.adminUser.id,
        action: "admin.logout",
        subjectType: "admin_session",
        subjectId: request.adminUser.jti,
        request,
        responseStatus: 200
      }, client);
    });
    return reply.send({ ok: true });
  });

  app.get("/admin/auth/me", {
    preHandler: [enforceAdminIpAllowlist, requireAdmin()]
  }, async (request, reply) => {
    const result = await query(
      `SELECT email, role, last_login_at FROM admin_users WHERE id = $1 LIMIT 1`,
      [request.adminUser.id]
    );
    const adminUser = result.rows[0];
    return reply.send({
      email: adminUser.email,
      role: adminUser.role,
      last_login_at: adminUser.last_login_at
    });
  });

  app.get("/admin/audit", {
    preHandler: [enforceAdminIpAllowlist, requireAdmin()]
  }, async (request, reply) => {
    const page = Math.max(1, Number.parseInt(request.query?.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query?.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const owner = request.adminUser.role === "owner";
    const result = await query(
      `
        SELECT id, admin_user_id, action, subject_type, subject_id, reason,
               request_ip, user_agent, response_status, created_at
        FROM admin_audit_log
        WHERE ($1::boolean OR admin_user_id = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4
      `,
      [owner, request.adminUser.id, limit, offset]
    );
    return reply.send({ audit: result.rows, page, limit });
  });
}
