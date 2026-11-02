#!/usr/bin/env node

// Operator-only retention tool. Dry-run is the default; deletion requires --execute.
// Deleting the live copy does not immediately remove provider backups (daily 6 days,
// weekly 1 month, monthly 3 months, PITR about 4 weeks).
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";

function assertLocalTestDatabase(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl || ""));
  } catch {
    throw new Error("Recovery payload purge requires a valid local PostgreSQL test database URL.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)
      || !localHosts.has(parsed.hostname)
      || !databaseName.toLowerCase().includes("test")) {
    throw new Error("Recovery payload purge refuses any database that is not local and named with 'test'.");
  }
}

async function eligibleSessions(client, now) {
  return (await client.query(
    `
      SELECT session.recovery_id,
             COUNT(part.part_no)::int AS part_count
      FROM recovery_sessions AS session
      LEFT JOIN recovery_parts AS part ON part.recovery_id = session.recovery_id
      WHERE session.completed_at < $1::timestamptz - INTERVAL '30 days'
        AND session.state = 'completed'
        AND (
          session.outcome = 'cleared'
          OR (
            session.outcome = 'not_cleared'
            AND COALESCE(
              (session.reconciliation_result->>'all_items_reported_by_device_accounted_for')::boolean,
              false
            )
          )
        )
      GROUP BY session.recovery_id
      ORDER BY session.recovery_id
    `,
    [now.toISOString()]
  )).rows;
}

export async function purgeRecoveryPayloads(pool, { execute = false, now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  const client = await pool.connect();
  try {
    await client.query(execute ? "BEGIN" : "BEGIN TRANSACTION READ ONLY");
    const eligible = await eligibleSessions(client, now);
    const recoveryIds = eligible.map((row) => row.recovery_id);
    const partCount = eligible.reduce((sum, row) => sum + Number(row.part_count), 0);
    if (execute && recoveryIds.length) {
      await client.query(`DELETE FROM recovery_parts WHERE recovery_id = ANY($1::uuid[])`, [recoveryIds]);
    }
    await client.query("COMMIT");
    return {
      mode: execute ? "execute" : "dry-run",
      session_count: recoveryIds.length,
      part_count: partCount,
      recovery_ids: recoveryIds
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  assertLocalTestDatabase(config.databaseUrl);
  const execute = process.argv.includes("--execute");
  const unexpected = process.argv.slice(2).filter((argument) => argument !== "--execute");
  if (unexpected.length) throw new Error("Only --execute is supported.");
  const pool = getPool();
  try {
    process.stdout.write(`${JSON.stringify(await purgeRecoveryPayloads(pool, { execute }))}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
