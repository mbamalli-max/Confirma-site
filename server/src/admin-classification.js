import { normalizePhoneNumber } from "./auth-utils.js";

export const CLASSIFICATIONS = Object.freeze(["EXTERNAL", "INTERNAL_TEST", "DEMO"]);
export const CLASSIFICATION_REASON_CODES = Object.freeze([
  "OPERATOR_TEST_ACCOUNT",
  "OPERATOR_DEMO_ACCOUNT",
  "OWNER_CLASSIFIED_EXTERNAL",
  "CORRECTION"
]);
export const REASON_CODES = CLASSIFICATION_REASON_CODES;

const VALID_REASONS = new Map([
  ["EXTERNAL", new Set(["OWNER_CLASSIFIED_EXTERNAL", "CORRECTION"])],
  ["INTERNAL_TEST", new Set(["OPERATOR_TEST_ACCOUNT", "CORRECTION"])],
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
        COUNT(*) FILTER (WHERE classification.classification = 'EXTERNAL') AS external,
        COUNT(*) FILTER (
          WHERE classification.classification IN ('INTERNAL_TEST', 'DEMO')
        ) AS internal_demo,
        COUNT(*) FILTER (WHERE classification.user_id IS NULL) AS unclassified,
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
    internal_demo: Number(row.internal_demo || 0),
    unclassified: Number(row.unclassified || 0),
    total: Number(row.total || 0)
  };
  if (counts.total !== counts.external + counts.internal_demo + counts.unclassified) {
    throw new Error("Classification counts do not reconcile.");
  }
  return counts;
}
