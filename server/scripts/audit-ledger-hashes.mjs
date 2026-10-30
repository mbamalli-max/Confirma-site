// Read-only, counts-only check before deploying T4: recompute every stored
// ledger entry's hash from its payload and compare with the stored entry_hash.
// Prints { total, match, mismatch, unparseable } and nothing else (no ids, no
// payload values). Deploy only if mismatch = 0 and unparseable = 0; anything
// else is unresolved and needs diagnosis, never a rewrite of stored records.
import pg from "pg";
import { computeLedgerEntryHash } from "../src/ledger-canonical.js";

export async function auditLedgerHashes(pool) {
  const counts = { total: 0, match: 0, mismatch: 0, unparseable: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const cursorName = "ledger_hash_audit";
    await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT entry_hash, payload FROM ledger_entries`);
    for (;;) {
      const batch = await client.query(`FETCH 500 FROM ${cursorName}`);
      if (!batch.rows.length) break;
      for (const row of batch.rows) {
        counts.total += 1;
        const payload = row.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          counts.unparseable += 1;
          continue;
        }
        if (computeLedgerEntryHash(payload) === row.entry_hash) counts.match += 1;
        else counts.mismatch += 1;
      }
    }
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false },
    options: "-c default_transaction_read_only=on -c statement_timeout=30000",
    max: 1
  });
  try {
    console.log(JSON.stringify(await auditLedgerHashes(pool)));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
