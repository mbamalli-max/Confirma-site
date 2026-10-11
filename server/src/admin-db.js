import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let adminReadPool = null;
let rebuildPool = null;

function validateDatabaseUrl(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required to use admin metrics.");
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection string.");
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol) || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL must identify a PostgreSQL database.");
  }
}

function poolOptions(max, options) {
  validateDatabaseUrl(config.databaseUrl);
  return {
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max,
    options
  };
}

export function getAdminReadPool() {
  if (!adminReadPool) {
    adminReadPool = new Pool(poolOptions(
      2,
      "-c statement_timeout=3000 -c default_transaction_read_only=on"
    ));
  }
  return adminReadPool;
}

export function getRebuildPool() {
  if (!rebuildPool) {
    rebuildPool = new Pool(poolOptions(1, "-c statement_timeout=10000"));
  }
  return rebuildPool;
}

export async function adminReadQuery(text, params = []) {
  return getAdminReadPool().query(text, params);
}

export async function rebuildQuery(text, params = []) {
  return getRebuildPool().query(text, params);
}

export async function withRebuildTransaction(run) {
  const client = await getRebuildPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAdminPools() {
  const pools = [adminReadPool, rebuildPool].filter(Boolean);
  adminReadPool = null;
  rebuildPool = null;
  await Promise.all(pools.map((pool) => pool.end()));
}
