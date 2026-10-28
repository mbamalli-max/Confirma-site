import { normalizePhoneNumber } from "./auth-utils.js";

export const CLASSIFICATIONS = Object.freeze(["EXTERNAL", "INTERNAL_TEST", "DEMO"]);
export const CLASSIFICATION_REASON_CODES = Object.freeze([
  "OPERATOR_TEST_ACCOUNT",
  "OPERATOR_DEMO_ACCOUNT",
  "OPERATOR_ADMIN_ACCOUNT",
  "OWNER_CLASSIFIED_EXTERNAL",
  "CORRECTION"
]);
export const REASON_CODES = CLASSIFICATION_REASON_CODES;

const VALID_REASONS = new Map([
  ["EXTERNAL", new Set(["OWNER_CLASSIFIED_EXTERNAL", "CORRECTION"])],
  ["INTERNAL_TEST", new Set(["OPERATOR_TEST_ACCOUNT", "OPERATOR_ADMIN_ACCOUNT", "CORRECTION"])],
  ["DEMO", new Set(["OPERATOR_DEMO_ACCOUNT", "CORRECTION"])],
  [null, new Set(["CORRECTION"])]
]);

function executeWith(executor, text, params = []) {
  return typeof executor === "function"
    ? executor(text, params)
    : executor.query(text, params);
}

export function isValidReasonFor(target, code) {
  return VALID_REASONS.get(target)?.has(code) === true;
}

export function buildClassificationAuditReason(previous, target, reasonCode) {
  if (!isValidReasonFor(target, reasonCode)) {
    throw new Error("Invalid classification reason code.");
  }
  const previousValue = previous ?? "UNCLASSIFIED";
  const targetValue = target ?? "UNCLASSIFIED";
  if (previousValue !== "UNCLASSIFIED" && !CLASSIFICATIONS.includes(previousValue)) {
    throw new Error("Invalid previous classification.");
  }
  return `${previousValue} -> ${targetValue}; ${reasonCode}`;
}

export async function resolveUserByPhone(phoneNumber, executor) {
  const result = await executeWith(
    executor,
    `SELECT id, created_at FROM users WHERE phone_number = $1 LIMIT 1`,
    [normalizePhoneNumber(phoneNumber)]
  );
  return result.rows[0] || null;
}

// Exclusion model (decision E1): an account is External unless it carries an
// INTERNAL_TEST or DEMO row. An explicit EXTERNAL row counts the same as no row.
export const EXCLUDED_CLASSIFICATIONS = Object.freeze(["INTERNAL_TEST", "DEMO"]);

export async function countByClassification(executor, {
  fromSql,
  userIdColumn,
  whereSql = "TRUE",
  params = []
}) {
  const result = await executeWith(
    executor,
    `
      SELECT
        COUNT(*) FILTER (
          WHERE classification.classification IS NULL OR classification.classification = 'EXTERNAL'
        ) AS external,
        COUNT(*) FILTER (
          WHERE classification.classification IN ('INTERNAL_TEST', 'DEMO')
        ) AS excluded,
        COUNT(*) AS total
      FROM ${fromSql}
      LEFT JOIN account_classification classification
        ON classification.user_id = ${userIdColumn}
      WHERE ${whereSql}
    `,
    params
  );
  const row = result.rows[0] || {};
  const counts = {
    external: Number(row.external || 0),
    excluded: Number(row.excluded || 0),
    total: Number(row.total || 0)
  };
  if (counts.total !== counts.external + counts.excluded) {
    throw new Error("Classification counts do not reconcile.");
  }
  return counts;
}

// When the exclusions last changed: the latest successful set or clear in the audit log
// (row timestamps alone would miss the clearing of the last row). It is the time of the
// last change, not a review of every account.
export async function readExclusionState(executor) {
  const result = await executeWith(
    executor,
    `
      WITH last_change AS (
        SELECT MAX(created_at) AS changed_at
        FROM admin_audit_log
        WHERE action IN ('admin.classification.set', 'admin.classification.clear')
          AND response_status = 200
      )
      SELECT
        last_change.changed_at,
        CASE WHEN last_change.changed_at IS NULL THEN NULL
             ELSE (SELECT COUNT(*)::int FROM users account WHERE account.created_at > last_change.changed_at)
        END AS created_since
      FROM last_change
    `
  );
  const row = result.rows[0] || {};
  return {
    exclusions_last_changed: row.changed_at ? new Date(row.changed_at).toISOString() : null,
    accounts_created_since: row.created_since === null || row.created_since === undefined
      ? null
      : Number(row.created_since)
  };
}
