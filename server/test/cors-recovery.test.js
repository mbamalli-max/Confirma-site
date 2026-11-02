import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, createCorsDelegator } from "../src/config.js";
import { registerRecoveryRoutes } from "../src/routes/recovery.js";

const PUBLIC_ORIGIN = "https://konfirmata.com";
const OTHER_ORIGIN = "https://untrusted.example";
const ADMIN_ORIGIN = "https://admin.example.test";
const RECOVERY_ID = "123e4567-e89b-12d3-a456-426614174000";
const BASE_METHODS = ["GET", "POST", "OPTIONS"];

const originalAdminCorsOrigins = config.adminCorsOrigins;

afterEach(() => {
  config.adminCorsOrigins = originalAdminCorsOrigins;
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cors, createCorsDelegator([PUBLIC_ORIGIN]));
  app.get("/health", async () => ({ ok: true }));
  app.post("/sync/entries", async () => ({ ok: true }));
  app.post("/admin/auth/login", async () => ({ ok: true }));
  await registerRecoveryRoutes(app);
  await app.ready();
  return app;
}

function allowedMethods(response) {
  return String(response.headers["access-control-allow-methods"] || "")
    .split(",")
    .map((method) => method.trim())
    .filter(Boolean);
}

async function preflight(app, url, method = "PUT", origin = PUBLIC_ORIGIN) {
  return app.inject({
    method: "OPTIONS",
    url,
    headers: {
      origin,
      "access-control-request-method": method
    }
  });
}

test("recovery part-upload preflight allows PUT for an allowed origin and ignores the query string", async () => {
  const app = await buildApp();
  try {
    const response = await preflight(
      app,
      `/recovery/sessions/${RECOVERY_ID}/parts/0?retry=1`
    );
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], PUBLIC_ORIGIN);
    assert.deepEqual(allowedMethods(response), [...BASE_METHODS, "PUT"]);
  } finally {
    await app.close();
  }
});

test("recovery part-upload preflight refuses a disallowed origin", async () => {
  const app = await buildApp();
  try {
    const response = await preflight(
      app,
      `/recovery/sessions/${RECOVERY_ID}/parts/0`,
      "PUT",
      OTHER_ORIGIN
    );
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("PUT is not allowed globally on unrelated public or admin routes", async () => {
  config.adminCorsOrigins = ADMIN_ORIGIN;
  const app = await buildApp();
  const cases = [
    ["/sync/entries", PUBLIC_ORIGIN],
    ["/recovery/sessions", PUBLIC_ORIGIN],
    [`/recovery/sessions/${RECOVERY_ID}/plan`, PUBLIC_ORIGIN],
    [`/recovery/sessions/${RECOVERY_ID}/complete`, PUBLIC_ORIGIN],
    ["/admin/auth/login", ADMIN_ORIGIN]
  ];
  try {
    for (const [url, origin] of cases) {
      const response = await preflight(app, url, "PUT", origin);
      assert.equal(response.headers["access-control-allow-origin"], origin, url);
      assert.deepEqual(allowedMethods(response), BASE_METHODS, url);
      assert.equal(allowedMethods(response).includes("PUT"), false, url);
    }
  } finally {
    await app.close();
  }
});

test("malformed recovery part paths do not allow PUT", async () => {
  const app = await buildApp();
  const paths = [
    "/recovery/sessions/not-a-uuid/parts/0",
    `/recovery/sessions/${RECOVERY_ID}/parts/not-an-integer`,
    `/recovery/sessions/${RECOVERY_ID}/parts/-1`,
    `/recovery/sessions/${RECOVERY_ID}/parts/0/extra`,
    `/recovery/sessions/${RECOVERY_ID}/parts/0/`
  ];
  try {
    for (const url of paths) {
      const response = await preflight(app, url);
      assert.equal(response.headers["access-control-allow-origin"], PUBLIC_ORIGIN, url);
      assert.deepEqual(allowedMethods(response), BASE_METHODS, url);
    }
  } finally {
    await app.close();
  }
});

test("existing GET, POST and OPTIONS preflight methods remain allowed", async () => {
  const app = await buildApp();
  try {
    for (const method of BASE_METHODS) {
      const response = await preflight(app, "/sync/entries", method);
      assert.equal(response.statusCode, 204, method);
      assert.equal(response.headers["access-control-allow-origin"], PUBLIC_ORIGIN, method);
      assert.deepEqual(allowedMethods(response), BASE_METHODS, method);
    }
  } finally {
    await app.close();
  }
});

test("an actual production recovery part PUT response carries the allowed CORS origin", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/recovery/sessions/${RECOVERY_ID}/parts/0`,
      headers: { origin: PUBLIC_ORIGIN },
      payload: { probe: true }
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["access-control-allow-origin"], PUBLIC_ORIGIN);
    assert.deepEqual(response.json(), { error: "token_missing" });
  } finally {
    await app.close();
  }
});
