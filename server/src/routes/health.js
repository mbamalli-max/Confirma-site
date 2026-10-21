import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { listMigrationFiles } from "../migration-files.js";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const defaultMigrationsDir = path.join(path.dirname(__filename), "../../migrations");

function remainingDeadlineMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function closeClient(client) {
  if (!client) return;

  try {
    const ending = client.end();
    ending?.catch?.(() => {});
  } catch {
    // A connection error can make end() throw synchronously. The stream is
    // destroyed below in either case.
  }

  try {
    client.connection?.stream?.destroy();
  } catch {
    // Cleanup must not change the readiness response.
  }
}

function defaultConnect(clientOptions) {
  return new Client(clientOptions);
}

function failureForError(error, stage, deadline) {
  if (stage === "connect") {
    return { ready: false, reason: "connect_timeout", code: error?.code };
  }

  if (error?.code === "57014" || remainingDeadlineMs(deadline) === 0) {
    return { ready: false, reason: "query_timeout", code: error?.code };
  }

  return { ready: false, reason: "query_error", code: error?.code };
}

async function runReadinessProbe({ connect, migrationsDir, deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  let client;
  let stage = "connect";
  let timedOut = false;
  let timeoutId;
  let clientError;
  let rejectClientError;
  const clientErrorPromise = new Promise((_, reject) => {
    rejectClientError = reject;
  });
  // The deadline can resolve the outer race before a client returned by the
  // factory reaches either inner race. Keep teardown errors handled in that
  // early-exit path as well.
  clientErrorPromise.catch(() => {});

  const probe = (async () => {
    try {
      const initialRemaining = remainingDeadlineMs(deadline);
      if (!initialRemaining || !config.databaseUrl) {
        return { ready: false, reason: "connect_timeout" };
      }

      client = await connect({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
        application_name: "confirma-readiness",
        connectionTimeoutMillis: initialRemaining,
        statement_timeout: initialRemaining,
        query_timeout: initialRemaining
      });

      // pg emits connection failures on the client itself. Keep this listener
      // installed through teardown: an error from end() or stream.destroy()
      // must not become an unhandled EventEmitter error.
      client.on("error", (error) => {
        if (clientError) return;
        clientError = error;
        rejectClientError(error);
      });

      if (timedOut || !remainingDeadlineMs(deadline)) {
        return { ready: false, reason: "connect_timeout" };
      }

      await Promise.race([client.connect(), clientErrorPromise]);
      stage = "query";

      const queryTimeout = remainingDeadlineMs(deadline);
      if (!queryTimeout) {
        return { ready: false, reason: "query_timeout" };
      }

      const [migrationFiles, appliedResult] = await Promise.race([
        Promise.all([
          listMigrationFiles(migrationsDir),
          client.query({
            text: "SELECT version FROM schema_migrations",
            query_timeout: queryTimeout
          })
        ]),
        clientErrorPromise
      ]);

      if (timedOut || !remainingDeadlineMs(deadline)) {
        return { ready: false, reason: "query_timeout" };
      }

      const appliedVersions = new Set(appliedResult.rows.map((row) => Number(row.version)));
      const missingVersion = migrationFiles.some((migration) => !appliedVersions.has(migration.version));
      return missingVersion
        ? { ready: false, reason: "missing_versions" }
        : { ready: true };
    } finally {
      closeClient(client);
    }
  })();

  const deadlineReached = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      closeClient(client);
      resolve({
        ready: false,
        reason: stage === "connect" ? "connect_timeout" : "query_timeout"
      });
    }, deadlineMs);
  });

  try {
    return await Promise.race([probe, deadlineReached]);
  } catch (error) {
    return failureForError(error, stage, deadline);
  } finally {
    clearTimeout(timeoutId);
    closeClient(client);
  }
}

export function registerReadinessRoute(app, options = {}) {
  const connect = options.connect || defaultConnect;
  const migrationsDir = options.migrationsDir || defaultMigrationsDir;
  const deadlineMs = options.deadlineMs ?? 3000;
  let inFlight = null;
  let lastFailureLogAt = 0;

  app.get("/ready", { config: { rateLimit: false } }, async (request, reply) => {
    inFlight ||= runReadinessProbe({ connect, migrationsDir, deadlineMs })
      .finally(() => {
        inFlight = null;
      });

    const result = await inFlight;
    if (!result.ready) {
      const now = Date.now();
      if (now - lastFailureLogAt >= 60_000) {
        lastFailureLogAt = now;
        app.log.warn({ reason: result.reason, code: result.code }, "Readiness probe failed");
      }
      return reply.code(503).send({ status: "not_ready" });
    }

    return reply.send({ status: "ready" });
  });
}
