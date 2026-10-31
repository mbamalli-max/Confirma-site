import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./src/db.js";
import { listMigrationFiles } from "./src/migration-files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "migrations");
const migrationsThrough = process.env.MIGRATIONS_THROUGH === undefined
  ? null
  : Number(process.env.MIGRATIONS_THROUGH);

if (migrationsThrough !== null && (!Number.isInteger(migrationsThrough) || migrationsThrough < 1)) {
  throw new Error("MIGRATIONS_THROUGH must be a positive migration version.");
}

function assertLocalTestMigrationBoundary(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl || ""));
  } catch {
    throw new Error("MIGRATIONS_THROUGH is permitted only for a valid local PostgreSQL test database URL.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)
      || !localHosts.has(parsed.hostname)
      || !databaseName.toLowerCase().includes("test")) {
    throw new Error("MIGRATIONS_THROUGH is permitted only for a local PostgreSQL database whose name contains 'test'.");
  }
}

if (migrationsThrough !== null) {
  // This is a test-fixture boundary, never a production migration control.
  // Validate it before getPool() so an unsafe invocation cannot connect or apply.
  assertLocalTestMigrationBoundary(process.env.DATABASE_URL);
  console.log(`Migration boundary in force through version ${migrationsThrough} (validated local test database).`);
}

function stripLineComments(sql) {
  return String(sql || "").replace(/--.*$/gm, "").trim();
}

async function ensureSchemaMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getPendingMigrations(pool) {
  const appliedResult = await pool.query("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(appliedResult.rows.map((row) => Number(row.version)));

  const migrations = await listMigrationFiles(migrationsDir);
  return migrations
    .filter((entry) => migrationsThrough === null || entry.version <= migrationsThrough)
    .filter((entry) => !appliedVersions.has(entry.version));
}

async function applyMigration(pool, migration) {
  const client = await pool.connect();
  try {
    const sql = await readFile(path.join(migrationsDir, migration.filename), "utf8");

    await client.query("BEGIN");
    if (stripLineComments(sql)) {
      await client.query(sql);
    }
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      [migration.version]
    );
    await client.query("COMMIT");

    console.log(`Applied migration ${migration.filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = getPool();
  try {
    await ensureSchemaMigrationsTable(pool);
    const pendingMigrations = await getPendingMigrations(pool);

    for (const migration of pendingMigrations) {
      await applyMigration(pool, migration);
    }

    if (!pendingMigrations.length) {
      console.log("No pending migrations.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration run failed.", error);
  process.exitCode = 1;
});
