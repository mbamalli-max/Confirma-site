import crypto from "node:crypto";
import { query, withTransaction } from "../../db.js";
import { requireAdmin, writeAuditRow } from "../../admin-auth-utils.js";
import {
  CLASSIFICATIONS,
  buildClassificationAuditReason,
  countByClassification,
  isValidReasonFor,
  readExclusionState,
  resolveUserByPhone
} from "../../admin-classification.js";
import { enforceAdminIpAllowlist } from "./auth.js";
import { API_VERSION, RETIRED_ROUTES, registerRetiredRoutes } from "./metrics.js";

const OWNER_ONLY = [enforceAdminIpAllowlist, requireAdmin(["owner"])];
const PREVIEW_FIELDS = new Set(["phone_number", "classification", "reason_code"]);

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPreviewBody(body) {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !PREVIEW_FIELDS.has(key))) return false;
  if (typeof body.phone_number !== "string" || !body.phone_number.trim()) return false;
  if (body.classification !== null && !CLASSIFICATIONS.includes(body.classification)) return false;
  if (typeof body.reason_code !== "string") return false;
  return isValidReasonFor(body.classification, body.reason_code);
}

function validApplyBody(body) {
  return isPlainObject(body)
    && Object.keys(body).length === 1
    && typeof body.confirmation_token === "string"
    && /^[0-9a-f]{64}$/.test(body.confirmation_token);
}

async function readAccountFacts(userId) {
  const result = await query(
    `
      SELECT
        classification.classification,
        COUNT(entries.entry_id)::int AS confirmed_records
      FROM users account
      LEFT JOIN account_classification classification
        ON classification.user_id = account.id
      LEFT JOIN device_identities device
        ON device.user_id = account.id
      LEFT JOIN ledger_entries entries
        ON entries.device_identity = device.device_identity
      WHERE account.id = $1
      GROUP BY classification.classification
    `,
    [userId]
  );
  return result.rows[0] || { classification: null, confirmed_records: 0 };
}

export async function registerAdminClassificationRoutes(app) {
  app.post("/admin/classification/preview", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    preHandler: OWNER_ONLY
  }, async (request, reply) => {
    const body = request.body;
    if (!validPreviewBody(body)) {
      return reply.code(400).send({ error: "Invalid classification preview request." });
    }

    const user = await resolveUserByPhone(body.phone_number, query);
    if (!user) {
      await writeAuditRow({
        adminUserId: request.adminUser.id,
        action: "admin.classification.miss",
        request,
        responseStatus: 404
      });
      return reply.code(404).send({ error: "No matching account." });
    }

    const facts = await readAccountFacts(user.id);
    const previousClassification = facts.classification || null;
    const confirmationToken = crypto.randomBytes(32).toString("hex");
    const hash = tokenHash(confirmationToken);
    const expiresAt = await withTransaction(async (client) => {
      await client.query(
        `
          DELETE FROM admin_classification_confirmations
          WHERE admin_user_id = $1 AND (used_at IS NOT NULL OR expires_at <= NOW())
        `,
        [request.adminUser.id]
      );
      const inserted = await client.query(
        `
          INSERT INTO admin_classification_confirmations (
            token_hash, admin_user_id, user_id, target_classification,
            previous_classification, reason_code, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 minutes')
          RETURNING expires_at
        `,
        [
          hash,
          request.adminUser.id,
          user.id,
          body.classification,
          previousClassification,
          body.reason_code
        ]
      );
      await writeAuditRow({
        adminUserId: request.adminUser.id,
        action: "admin.classification.preview",
        subjectType: "user",
        subjectId: user.id,
        request,
        responseStatus: 200
      }, client);
      return inserted.rows[0].expires_at;
    });

    return reply.send({
      account: {
        created_on: new Date(user.created_at).toISOString().slice(0, 10),
        confirmed_records: Number(facts.confirmed_records)
      },
      current_classification: previousClassification,
      target_classification: body.classification,
      reason_code: body.reason_code,
      confirmation_token: confirmationToken,
      expires_at: new Date(expiresAt).toISOString()
    });
  });

  app.post("/admin/classification/apply", {
    preHandler: OWNER_ONLY
  }, async (request, reply) => {
    const body = request.body;
    if (!validApplyBody(body)) {
      return reply.code(400).send({ error: "Invalid classification apply request." });
    }

    const result = await withTransaction(async (client) => {
      const confirmationResult = await client.query(
        `
          SELECT token_hash, admin_user_id, user_id, target_classification,
                 previous_classification, reason_code, expires_at, used_at
          FROM admin_classification_confirmations
          WHERE token_hash = $1
          FOR UPDATE
        `,
        [tokenHash(body.confirmation_token)]
      );
      const confirmation = confirmationResult.rows[0];
      if (!confirmation
          || confirmation.admin_user_id !== request.adminUser.id
          || confirmation.used_at) {
        await writeAuditRow({
          adminUserId: request.adminUser.id,
          action: "admin.classification.apply_rejected",
          request,
          responseStatus: 409
        }, client);
        return { status: 409, body: { error: "confirmation_invalid" } };
      }

      const accountResult = await client.query(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [confirmation.user_id]
      );
      if (!accountResult.rows[0]) {
        await writeAuditRow({
          adminUserId: request.adminUser.id,
          action: "admin.classification.apply_rejected",
          request,
          responseStatus: 409
        }, client);
        return { status: 409, body: { error: "confirmation_invalid" } };
      }

      const expiryResult = await client.query(
        `
          SELECT expires_at <= clock_timestamp() AS expired
          FROM admin_classification_confirmations
          WHERE token_hash = $1
        `,
        [confirmation.token_hash]
      );
      if (expiryResult.rows[0].expired) {
        await writeAuditRow({
          adminUserId: request.adminUser.id,
          action: "admin.classification.apply_rejected",
          request,
          responseStatus: 409
        }, client);
        return { status: 409, body: { error: "confirmation_invalid" } };
      }

      const currentResult = await client.query(
        `SELECT classification FROM account_classification WHERE user_id = $1`,
        [confirmation.user_id]
      );
      const current = currentResult.rows[0]?.classification || null;
      if (current !== confirmation.previous_classification) {
        await client.query(
          `UPDATE admin_classification_confirmations SET used_at = NOW() WHERE token_hash = $1`,
          [confirmation.token_hash]
        );
        await writeAuditRow({
          adminUserId: request.adminUser.id,
          action: "admin.classification.apply_rejected",
          subjectType: "user",
          subjectId: confirmation.user_id,
          request,
          responseStatus: 409
        }, client);
        return { status: 409, body: { error: "state_changed" } };
      }

      if (confirmation.target_classification === null) {
        await client.query(`DELETE FROM account_classification WHERE user_id = $1`, [confirmation.user_id]);
      } else {
        await client.query(
          `
            INSERT INTO account_classification (
              user_id, classification, reason_code, classified_by
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE SET
              classification = EXCLUDED.classification,
              reason_code = EXCLUDED.reason_code,
              classified_by = EXCLUDED.classified_by,
              classified_at = NOW(),
              updated_at = NOW()
          `,
          [
            confirmation.user_id,
            confirmation.target_classification,
            confirmation.reason_code,
            request.adminUser.id
          ]
        );
      }
      await client.query(
        `UPDATE admin_classification_confirmations SET used_at = NOW() WHERE token_hash = $1`,
        [confirmation.token_hash]
      );
      await client.query(
        `UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`
      );
      await writeAuditRow({
        adminUserId: request.adminUser.id,
        action: confirmation.target_classification === null
          ? "admin.classification.clear"
          : "admin.classification.set",
        subjectType: "user",
        subjectId: confirmation.user_id,
        reason: buildClassificationAuditReason(
          confirmation.previous_classification,
          confirmation.target_classification,
          confirmation.reason_code
        ),
        request,
        responseStatus: 200
      }, client);
      return {
        status: 200,
        body: {
          applied: true,
          previous_classification: confirmation.previous_classification,
          classification: confirmation.target_classification
        }
      };
    });

    return reply.code(result.status).send(result.body);
  });

  registerRetiredRoutes(app, RETIRED_ROUTES.filter(([, url]) => url === "/admin/classification/summary"));

  app.get("/admin/v2/exclusions", {
    preHandler: OWNER_ONLY
  }, async (request, reply) => {
    const [accounts, state] = await Promise.all([
      countByClassification(query, {
        fromSql: "users account",
        userIdColumn: "account.id",
        whereSql: "TRUE",
        params: []
      }),
      readExclusionState(query)
    ]);
    return reply.send({
      api_version: API_VERSION,
      accounts,
      ...state,
      audience: "operator_only",
      suppression: "none",
      definitions: {
        external: "All accounts except those the owner has excluded.",
        excluded: "Accounts the owner has identified as internal test, demonstration or administrator accounts.",
        total: "All accounts.",
        exclusions_last_changed: "When an exclusion was last made or removed. Not a review of every account.",
        accounts_created_since: "Accounts created after the exclusions last changed."
      },
      as_of: new Date().toISOString()
    });
  });
}
