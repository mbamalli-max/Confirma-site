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
    pool