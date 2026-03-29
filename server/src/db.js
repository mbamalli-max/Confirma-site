import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let pool = null;

function getSslConfig() {
  return config.databaseSsl ? { rejectUnauthorized: false } : undefined;
}

function validateDatabaseUrl(connectionString) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to use the sync server.");
  }

  let parsed = null;
  try {
    parsed = new URL(connectionString);
  } catch (error) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection string.");
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://.");
  }

  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL is missing the database name segment.");
  }
}

export function getPool() {
  validateDatabaseUrl(config.databaseUrl);

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: getSslConfig()
    });
  }

  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(run) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
