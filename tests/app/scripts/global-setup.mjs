import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertLocalDatabaseUrl, assertLocalUrl, databaseCommandTarget, dropDatabaseWithRetry } from "./local-only.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed while preparing the local test database.`);
}

export default async function globalSetup() {
  // This guard runs before Playwright opens a browser or makes a request.
  assertLocalUrl("APP_TEST_URL", process.env.APP_TEST_URL || "http://127.0.0.1:5500");
  assertLocalUrl("APP_TEST_API_URL", process.env.APP_TEST_API_URL || "http://127.0.0.1:8787");
  const database = assertLocalDatabaseUrl(process.env.APP_TEST_DATABASE_URL);
  const databaseUrl = database.toString();
  const target = databaseCommandTarget(database);
  // The name guard above makes this destructive operation safe for the
  // explicit throwaway target only. `dropdb --if-exists` also makes reruns
  // deterministic after an interrupted browser test.
  await dropDatabaseWithRetry(database);
  run("createdb", [...target.args, target.databaseName], { env: { ...process.env, ...target.env } });
  const schema = fileURLToPath(new URL("../../../server/schema.sql", import.meta.url));
  run("psql", [
    ...target.args, "--dbname", target.databaseName, "--set", "ON_ERROR_STOP=1", "--file", schema
  ], { env: { ...process.env, ...target.env } });
  const migrate = fileURLToPath(new URL("../../../server/migrate.js", import.meta.url));
  run(process.execPath, [migrate], { env: { ...process.env, DATABASE_URL: databaseUrl } });
  const rateFile = fileURLToPath(new URL("../test-results/otp-rate-limit.json", import.meta.url));
  await mkdir(fileURLToPath(new URL("../test-results/", import.meta.url)), { recursive: true });
  await writeFile(rateFile, JSON.stringify({ request: [], verify: [], totals: { request: 0, verify: 0 } }), "utf8");
}
