import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let pool = null;

function getSslConfig() {
  return config.databaseSsl ? { rejectUnauthorized: false } : undefined;
}

export function getPool() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to use the sync server.");
  }

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
