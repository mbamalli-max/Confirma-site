import { spawnSync } from "node:child_process";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertLocalUrl(name, value, { required = true } = {}) {
  if (!value && !required) return null;
  if (!value) throw new Error(`${name} is required and must use a local URL.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid local URL.`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`${name} refuses non-local host ${parsed.hostname}.`);
  }
  return parsed;
}

export function assertLocalDatabaseUrl(value) {
  const parsed = assertLocalUrl("APP_TEST_DATABASE_URL", value);
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error("APP_TEST_DATABASE_URL must use a PostgreSQL connection URL.");
  }
  const databaseName = decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "");
  if (!databaseName || databaseName.includes("/") || !/test|tmp|throwaway/i.test(databaseName)) {
    throw new Error("APP_TEST_DATABASE_URL must name an explicit local test/throwaway database.");
  }
  return parsed;
}

// PostgreSQL command-line utilities accept a database *name*, not a URL.
// Keep URL parsing and the local/name guard in one place so callers cannot
// accidentally hand a connection string to a destructive command.
export function databaseCommandTarget(databaseUrl) {
  const parsed = assertLocalDatabaseUrl(databaseUrl.toString());
  const databaseName = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  const args = ["--host", parsed.hostname];
  if (parsed.port) args.push("--port", parsed.port);
  if (parsed.username) args.push("--username", decodeURIComponent(parsed.username));
  return {
    databaseName,
    args,
    env: parsed.password ? { PGPASSWORD: decodeURIComponent(parsed.password) } : {}
  };
}

function otherDatabaseSessionCount(target) {
  const databaseName = target.databaseName.replaceAll("'", "''");
  const result = spawnSync("psql", [
    ...target.args,
    "--dbname", "postgres",
    "--no-align", "--tuples-only", "--quiet", "--set", "ON_ERROR_STOP=1",
    "--command", `SELECT count(*) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`
  ], {
    encoding: "utf8",
    env: { ...process.env, ...target.env }
  });
  return result.status === 0 ? Number(result.stdout.trim() || 0) : "unknown";
}

export async function dropDatabaseWithRetry(databaseUrl, { timeoutMs = 30_000, intervalMs = 1_000 } = {}) {
  const target = databaseCommandTarget(databaseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  do {
    const result = spawnSync("dropdb", ["--if-exists", ...target.args, target.databaseName], {
      encoding: "utf8",
      env: { ...process.env, ...target.env }
    });
    if (result.status === 0) return;
    lastError = String(result.stderr || "").trim();
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);

  const sessions = otherDatabaseSessionCount(target);
  throw new Error(
    `Unable to drop local test database "${target.databaseName}" after ${Math.ceil(timeoutMs / 1000)} seconds; `
    + `${sessions} other session${sessions === 1 ? "" : "s"} remain connected.`
    + (lastError ? ` Last dropdb error: ${lastError}` : "")
  );
}
