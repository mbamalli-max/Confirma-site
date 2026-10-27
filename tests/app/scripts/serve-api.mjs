import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertLocalDatabaseUrl, assertLocalUrl } from "./local-only.mjs";

const api = assertLocalUrl("APP_TEST_API_URL", process.env.APP_TEST_API_URL || "http://127.0.0.1:8787");
const app = assertLocalUrl("APP_TEST_URL", process.env.APP_TEST_URL || "http://127.0.0.1:5500");
const database = assertLocalDatabaseUrl(process.env.APP_TEST_DATABASE_URL);
const server = fileURLToPath(new URL("../../../server/server.js", import.meta.url));
const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: api.hostname,
    PORT: api.port || "8787",
    DATABASE_URL: database.toString(),
    NODE_ENV: "test",
    ALLOW_DEV_OTP: "true",
    JWT_SECRET: "local-app-playwright-secret",
    SERVER_RECEIPT_SECRET: "local-app-playwright-receipt",
    CORS_ORIGINS: app.origin
  }
});

const stop = () => child.kill("SIGTERM");
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.once("exit", (code) => process.exit(code ?? 0));
