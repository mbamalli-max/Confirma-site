import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "migrations");

function parseMigrationVersion(filename) {
  const match = String(filename || "").match(/^(\d+)_.*\.sql$/i);
  return match ? Number.parseInt(match[1], 10) : null;
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

  const entries = await readdir(migrationsDir);
  return entries
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => ({
      filename,
      version: parseMigrationVersion(filename)
    }))
    .filter((entry) => Number.isInteger(entry.version))
    .sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename))
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
