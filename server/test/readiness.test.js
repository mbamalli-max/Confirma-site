import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import pg from "pg";
import { config } from "../src/config.js";
import { listMigrationFiles, parseMigrationVersion } from "../src/migration-files.js";
import { registerReadinessRoute } from "../src/routes/health.js";
import { assertLocalTestDatabase, createTestPool } from "./helpers/db.js";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.join(path.dirname(__filename), "../migrations");

// This guard intentionally runs before a pool is created or any SQL is issued.
assertLocalTestDatabase(config.databaseUrl);

const database = createTestPool(config.databaseUrl, config.databaseSsl);
let requiredMigrations;
let originalMigrationRows;

async function createReadinessApp(options = {}, useGlobalRateLimit = false) {
  const app = Fastify({ logger: false });
  if (useGlobalRateLimit) {
    await app.register(rateLimit, { global: true, max: 1, timeWindow: "1 minute" });
  }
  registerReadinessRoute(app, { migrationsDir, ...options });
  await app.ready();
  return app;
}

async function withReadinessApp(options, run, useGlobalRateLimit = false) {
  const app = await createReadinessApp(options, useGlobalRateLimit);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function restoreAllMigrationVersions() {
  for (const migration of requiredMigrations) {
    await database.query(
      "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [migration.version]
    );
  }
}

async function readinessBackendCount() {
  const result = await database.query(
    "SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE application_name = 'confirma-readiness'"
  );
  return result.rows[0].count;
}

async function waitForAsyncValue(readValue, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the expected database activity.");
}

function sleepingClient(clientOptions, sleepSeconds = 1) {
  const client = new Client(clientOptions);
  const query = client.query.bind(client);
  client.query = () => query("SELECT pg_sleep($1)", [sleepSeconds]);
  return client;
}

async function reserveUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function unreachableClient(clientOptions, port) {
  const databaseUrl = new URL(config.databaseUrl);
  return new Client({
    ...clientOptions,
    connectionString: undefined,
    host: "127.0.0.1",
    port,
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""))
  });
}

class EstablishedErrorClient extends EventEmitter {
  constructor() {
    super();
    this.connectCalls = 0;
    this.endCalls = 0;
    this.destroyCalls = 0;
    this.queryStarted = new Promise((resolve) => {
      this.resolveQueryStarted = resolve;
    });
    this.connection = {
      stream: {
        destroy: () => {
          this.destroyCalls += 1;
        }
      }
    };
  }

  async connect() {
    this.connectCalls += 1;
  }

  query() {
    this.resolveQueryStarted();
    return new Promise(() => {});
  }

  end() {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

class TeardownErrorClient extends EventEmitter {
  constructor(rows) {
    super();
    this.rows = rows;
    this.endCalls = 0;
    this.destroyCalls = 0;
    this.connection = {
      stream: {
        destroy: () => {
          this.destroyCalls += 1;
          queueMicrotask(() => this.emit("error", new Error("stream teardown error")));
        }
      }
    };
  }

  async connect() {}

  async query() {
    return { rows: this.rows };
  }

  end() {
    this.endCalls += 1;
    queueMicrotask(() => this.emit("error", new Error("end teardown error")));
    return Promise.resolve();
  }
}

before(async () => {
  requiredMigrations = await listMigrationFiles(migrationsDir);
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  originalMigrationRows = (await database.query(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version"
  )).rows;
  await restoreAllMigrationVersions();
});

beforeEach(async () => {
  await restoreAllMigrationVersions();
});

after(async () => {
  await database.query("DELETE FROM schema_migrations");
  for (const row of originalMigrationRows) {
    await database.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)",
      [row.version, row.applied_at]
    );
  }
  await database.end();
});

test("1: all recorded migrations make /ready return exactly ready", async () => {
  await withReadinessApp({}, async (app) => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: "ready" });
  });
});

test("2: a missing migration version makes /ready not ready", async () => {
  const missing = requiredMigrations.at(-1);
  assert.ok(missing, "expected at least one migration file");
  await database.query("DELETE FROM schema_migrations WHERE version = $1", [missing.version]);

  await withReadinessApp({}, async (app) => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { status: "not_ready" });
  });
});

test("3: an injected connection error is not exposed", async () => {
  await withReadinessApp({
    connect: async () => {
      const error = new Error("connection secret must not reach the response");
      error.code = "ECONNREFUSED";
      throw error;
    }
  }, async (app) => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { status: "not_ready" });
    assert.equal(response.body.includes("connection secret"), false);
  });
});

test("4: a real stalled query times out and leaves no readiness backend", async () => {
  const deadlineMs = 100;
  const baseline = await readinessBackendCount();
  await withReadinessApp({
    deadlineMs,
    connect: (clientOptions) => sleepingClient(clientOptions, 1)
  }, async (app) => {
    const startedAt = Date.now();
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { status: "not_ready" });
    assert.ok(Date.now() - startedAt <= deadlineMs + 500, "probe exceeded its deadline budget");
  });
  await waitForAsyncValue(readinessBackendCount, (count) => count === baseline, 2000);
});

test("5: a real unreachable connection returns within the deadline", async () => {
  const deadlineMs = 100;
  const port = await reserveUnusedPort();
  await withReadinessApp({
    deadlineMs,
    connect: (clientOptions) => unreachableClient(clientOptions, port)
  }, async (app) => {
    const startedAt = Date.now();
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { status: "not_ready" });
    assert.ok(Date.now() - startedAt <= deadlineMs + 500, "unreachable probe exceeded its deadline budget");
  });
});

test("6: repeated timeouts recover without accumulating readiness backends", async () => {
  const deadlineMs = 75;
  const baseline = await readinessBackendCount();
  let attempts = 0;
  await withReadinessApp({
    deadlineMs,
    connect: (clientOptions) => {
      attempts += 1;
      return attempts <= 20
        ? sleepingClient(clientOptions, 1)
        : new Client(clientOptions);
    }
  }, async (app) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503, response.body);
    }
    const recovered = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.deepEqual(recovered.json(), { status: "ready" });
  });
  assert.equal(attempts, 21);
  await waitForAsyncValue(readinessBackendCount, (count) => count === baseline, 3000);
});

test("7: thirty concurrent probes share one connection", async () => {
  let connectionCount = 0;
  await withReadinessApp({
    connect: (clientOptions) => {
      connectionCount += 1;
      return new Client(clientOptions);
    }
  }, async (app) => {
    const responses = await Promise.all(
      Array.from({ length: 30 }, () => app.inject({ method: "GET", url: "/ready" }))
    );
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { status: "ready" });
    }
  });
  assert.equal(connectionCount, 1);
});

test("8: readiness is exempt from the global rate limit", async () => {
  await withReadinessApp({}, async (app) => {
    for (let request = 0; request < 50; request += 1) {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { status: "ready" });
    }
  }, true);
});

test("9: migration-file parsing and selection match the runner without import side effects", async () => {
  assert.equal(parseMigrationVersion("001_baseline.sql"), 1);
  assert.equal(parseMigrationVersion("007_missing_columns.sql"), 7);
  assert.equal(parseMigrationVersion("not-a-migration.sql"), null);
  assert.equal(parseMigrationVersion("008_missing_extension.txt"), null);

  const entries = await readdir(migrationsDir);
  const runnerSelection = entries
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => ({ filename, version: parseMigrationVersion(filename) }))
    .filter((entry) => Number.isInteger(entry.version))
    .sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));
  assert.deepEqual(await listMigrationFiles(migrationsDir), runnerSelection);

  const beforeImport = await readinessBackendCount();
  const moduleUrl = new URL("../src/migration-files.js", import.meta.url);
  const imported = await import(`${moduleUrl.href}?side-effect-check=${Date.now()}`);
  assert.deepEqual(Object.keys(imported).sort(), ["listMigrationFiles", "parseMigrationVersion"]);
  assert.equal(await readinessBackendCount(), beforeImport);
});

test("10: an established client error settles promptly, cleans up, and the next probe recovers", async () => {
  const deadlineMs = 5000;
  const baseline = await readinessBackendCount();
  let attempts = 0;
  let failedClient;
  let resolveFailedClient;
  const failedClientCreated = new Promise((resolve) => {
    resolveFailedClient = resolve;
  });
  await withReadinessApp({
    deadlineMs,
    connect: (clientOptions) => {
      attempts += 1;
      if (attempts === 1) {
        failedClient = new EstablishedErrorClient();
        resolveFailedClient(failedClient);
        return failedClient;
      }
      return new Client(clientOptions);
    }
  }, async (app) => {
    const pendingResponse = app.inject({ method: "GET", url: "/ready" });
    await failedClientCreated;
    await failedClient.queryStarted;
    const emittedAt = Date.now();
    const error = new Error("established connection failed");
    error.code = "ECONNRESET";
    failedClient.emit("error", error);

    const response = await pendingResponse;
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { status: "not_ready" });
    assert.ok(Date.now() - emittedAt < 500, "client error waited for the probe deadline");
    assert.ok(failedClient.endCalls > 0, "failed client was not closed");
    assert.ok(failedClient.destroyCalls > 0, "failed client stream was not destroyed");

    const recovered = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.deepEqual(recovered.json(), { status: "ready" });
  });
  assert.equal(attempts, 2);
  await waitForAsyncValue(readinessBackendCount, (count) => count === baseline, 2000);
});

test("11: a client error emitted during teardown remains handled", async () => {
  const deadlineMs = 5000;
  const baseline = await readinessBackendCount();
  let attempts = 0;
  let teardownClient;
  await withReadinessApp({
    deadlineMs,
    connect: (clientOptions) => {
      attempts += 1;
      if (attempts === 1) {
        teardownClient = new TeardownErrorClient(
          requiredMigrations.map((migration) => ({ version: migration.version }))
        );
        return teardownClient;
      }
      return new Client(clientOptions);
    }
  }, async (app) => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: "ready" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(teardownClient.endCalls > 0, "teardown client was not closed");
    assert.ok(teardownClient.destroyCalls > 0, "teardown client stream was not destroyed");

    const recovered = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.deepEqual(recovered.json(), { status: "ready" });
  });
  assert.equal(attempts, 2);
  await waitForAsyncValue(readinessBackendCount, (count) => count === baseline, 2000);
});

test("12: an early deadline handles a client error emitted during teardown", async () => {
  const deadlineMs = 10;
  let attempts = 0;
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const connect = (clientOptions) => {
    attempts += 1;
    if (attempts === 1) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new TeardownErrorClient(
            requiredMigrations.map((migration) => ({ version: migration.version }))
          ));
        }, 40);
      });
    }
    return new Client(clientOptions);
  };

  try {
    await withReadinessApp({
      deadlineMs,
      connect
    }, async (app) => {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), { status: "not_ready" });

      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.deepEqual(unhandledRejections, []);
    });

    await withReadinessApp({ connect }, async (app) => {
      const recovered = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.deepEqual(recovered.json(), { status: "ready" });
    });
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.equal(attempts, 2);
});
