import pg from "pg";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const { Pool } = pg;
const runFile = promisify(execFile);
const serverDir = fileURLToPath(new URL("../..", import.meta.url));

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

/**
 * Build a private, local database at a migration boundary. Historical stages
 * start from the pinned pre-M1 fixture; the working schema.sql is deliberately
 * post-022 and is used by fresh-install tests.
 */
export async function createStageDatabase(throughVersion, {
  databaseUrl,
  databaseSsl = false,
  freshSchema = false
} = {}) {
  assertLocalTestDatabase(databaseUrl);
  if (!Number.isInteger(throughVersion) || throughVersion < 1) {
    throw new TypeError("throughVersion must be a positive migration version.");
  }
  const source = new URL(databaseUrl);
  // PostgreSQL identifiers are limited to 63 bytes.  Do not derive this from
  // the configured database name: long test database names are silently
  // truncated by PostgreSQL and can collide across concurrent test processes.
  const name = `kf_stage_test_${Math.random().toString(16).slice(2, 10)}`;
  source.pathname = `/${encodeURIComponent(name)}`;
  const stageUrl = source.toString();
  assertLocalTestDatabase(stageUrl);
  const adminUrl = new URL(stageUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), ssl: databaseSsl ? { rejectUnauthorized: false } : undefined, max: 1 });
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    pool = createTestPool(stageUrl, databaseSsl);
    const schema = freshSchema
      ? await readFile(path.join(serverDir, "schema.sql"), "utf8")
      : await readFile(path.join(serverDir, "test", "fixtures", "schema-pre-m1.sql"), "utf8");
    await pool.query(schema);
    await pool.end();
    await runFile(process.execPath, ["migrate.js"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: stageUrl, MIGRATIONS_THROUGH: String(throughVersion) }
    });
    pool = createTestPool(stageUrl, databaseSsl);
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`).catch(() => {});
    await admin.end();
    throw error;
  }
  return {
    pool,
    url: stageUrl,
    async runMigrations(through = throughVersion) {
      return runFile(process.execPath, ["migrate.js"], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: stageUrl, MIGRATIONS_THROUGH: String(through) }
      });
    },
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      await admin.end();
    }
  };
}

export function assertLocalTestDatabase(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl || ""));
  } catch {
    throw new Error("Identity-linking tests require a valid local PostgreSQL test database URL.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)
      || !localHosts.has(parsed.hostname)
      || !databaseName.toLowerCase().includes("test")) {
    throw new Error("Identity-linking tests refuse any database that is not local and named with 'test'.");
  }
}

export function createTestPool(databaseUrl, databaseSsl = false) {
  assertLocalTestDatabase(databaseUrl);
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 25
  });
}

export async function resetTestDatabase(pool) {
  await pool.query("TRUNCATE TABLE users, otp_challenges, otp_verify_failures RESTART IDENTITY CASCADE");
}

export async function getBackendPid(client) {
  const result = await client.query("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0].pid);
}

function normalizeExpectedWaiters(expectedWaiters) {
  if (!Array.isArray(expectedWaiters) || expectedWaiters.length === 0) {
    throw new TypeError("expectedWaiters must be a non-empty array of query patterns.");
  }

  return expectedWaiters.map((expected, index) => {
    const hasPattern = expected
      && typeof expected === "object"
      && !(expected instanceof RegExp)
      && Object.hasOwn(expected, "pattern");
    const pattern = hasPattern ? expected.pattern : expected;
    if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
      throw new TypeError(`Expected waiter ${index + 1} must provide a string or RegExp query pattern.`);
    }
    const pid = hasPattern ? expected.pid : undefined;
    if (pid !== undefined && !Number.isInteger(pid)) {
      throw new TypeError(`Expected waiter ${index + 1} pid must be an integer.`);
    }
    return {
      description: hasPattern && expected.description ? expected.description : String(pattern),
      pattern,
      pid
    };
  });
}

function queryMatchesPattern(query, pattern) {
  if (typeof pattern === "string") return query.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(query);
}

function formatWaiters(waiters) {
  if (waiters.length === 0) return "none";
  return waiters
    .map(({ pid, query }) => `${pid}: ${JSON.stringify(query.trim())}`)
    .join("; ");
}

function assignExpectedWaiters(waiters, expectedWaiters) {
  const candidates = expectedWaiters.map(({ pattern, pid: expectedPid }) => waiters
    .filter(({ pid, query }) => (expectedPid === undefined || pid === expectedPid)
      && queryMatchesPattern(query, pattern))
    .map(({ pid }) => pid));

  const assignment = Array(expectedWaiters.length).fill(null);
  function assign(index, usedPids) {
    if (index === candidates.length) return true;
    for (const pid of candidates[index]) {
      if (usedPids.has(pid)) continue;
      assignment[index] = pid;
      usedPids.add(pid);
      if (assign(index + 1, usedPids)) return true;
      usedPids.delete(pid);
      assignment[index] = null;
    }
    return false;
  }

  return assign(0, new Set()) ? assignment : null;
}

export async function waitForBackendsBlockedBy(pool, blockerPid, expectedWaiters, timeoutMs = 5000) {
  const expected = normalizeExpectedWaiters(expectedWaiters);
  const deadline = Date.now() + timeoutMs;
  let lastWaiters = [];
  while (Date.now() < deadline) {
    const result = await pool.query(
      `
        WITH RECURSIVE lock_waiters AS (
          SELECT activity.pid, activity.query
          FROM pg_stat_activity AS activity
          WHERE activity.datname = current_database()
            AND activity.wait_event_type = 'Lock'
            AND activity.pid <> $1
            AND activity.pid <> pg_backend_pid()
        ), blocking_chain AS (
          SELECT waiter.pid AS waiter_pid,
                 blocker.pid AS blocking_pid,
                 ARRAY[waiter.pid, blocker.pid] AS path
          FROM lock_waiters AS waiter
          CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocker(pid)

          UNION ALL

          SELECT chain.waiter_pid,
                 blocker.pid AS blocking_pid,
                 array_append(chain.path, blocker.pid)
          FROM blocking_chain AS chain
          CROSS JOIN LATERAL unnest(pg_blocking_pids(chain.blocking_pid)) AS blocker(pid)
          WHERE NOT blocker.pid = ANY(chain.path)
        )
        SELECT DISTINCT ON (chain.waiter_pid)
               chain.waiter_pid,
               waiters.query
        FROM blocking_chain AS chain
        INNER JOIN lock_waiters AS waiters
          ON waiters.pid = chain.waiter_pid
        WHERE chain.blocking_pid = $1
        ORDER BY chain.waiter_pid
      `,
      [blockerPid]
    );
    const waiters = result.rows.map((row) => ({
      pid: Number(row.waiter_pid),
      query: String(row.query || "")
    }));
    lastWaiters = waiters;
    const unexpected = waiters.filter(({ query }) => !expected.some(({ pattern }) => (
      queryMatchesPattern(query, pattern)
    )));

    if (unexpected.length > 0) {
      throw new Error(
        `Unexpected Lock-waiter(s) blocked by backend ${blockerPid}: ${formatWaiters(unexpected)}. `
        + `Expected: ${expected.map(({ description }) => description).join("; ")}.`
      );
    }
    if (waiters.length > expected.length) {
      throw new Error(
        `Found ${waiters.length} Lock-waiters blocked by backend ${blockerPid}; expected exactly `
        + `${expected.length}. Waiters: ${formatWaiters(waiters)}.`
      );
    }
    if (waiters.length === expected.length) {
      const assignedPids = assignExpectedWaiters(waiters, expected);
      if (!assignedPids) {
        throw new Error(
          `Lock-waiters blocked by backend ${blockerPid} did not match distinct expected requests. `
          + `Waiters: ${formatWaiters(waiters)}. `
          + `Expected: ${expected.map(({ description }) => description).join("; ")}.`
        );
      }
      return assignedPids;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${expected.length} expected Lock-waiter(s) to be blocked by backend `
    + `${blockerPid}. Last observed waiters: ${formatWaiters(lastWaiters)}. `
    + `Expected: ${expected.map(({ description }) => description).join("; ")}.`
  );
}

export async function waitForBlockingRelationship(pool, requestPid, blockerPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `
        SELECT activity.wait_event_type,
               pg_blocking_pids(activity.pid) AS blocking_pids
        FROM pg_stat_activity AS activity
        WHERE activity.pid = $1
      `,
      [requestPid]
    );
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock"
        && (row.blocking_pids || []).map(Number).includes(Number(blockerPid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the request backend to be blocked by the competing transaction.");
}

export async function waitForValue(readValue, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected database activity.");
}

export function instrumentApplicationPool(pool) {
  const originalConnect = pool.connect.bind(pool);
  const state = {
    active: 0,
    maxActive: 0,
    checkoutPids: [],
    transactionPids: [],
    queryTexts: [],
    commitsUntilFailure: null,
    failQueryPattern: null
  };

  async function instrumentClient(client) {
    const pid = await getBackendPid(client);
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    let released = false;

    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.checkoutPids.push(pid);

    client.query = function instrumentedQuery(...args) {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const callback = typeof args[args.length - 1] === "function"
        ? args[args.length - 1]
        : null;
      if (/^\s*BEGIN\b/i.test(String(text || ""))) {
        state.transactionPids.push(pid);
      }
      state.queryTexts.push(String(text || ""));
      if (state.commitsUntilFailure !== null && /^\s*COMMIT\b/i.test(String(text || ""))) {
        state.commitsUntilFailure -= 1;
        if (state.commitsUntilFailure === 0) {
          state.commitsUntilFailure = null;
          const error = new Error("Forced test commit failure.");
          if (callback) {
            process.nextTick(callback, error);
            return undefined;
          }
          return Promise.reject(error);
        }
      }
      if (state.failQueryPattern?.test(String(text || ""))) {
        state.failQueryPattern = null;
        const error = new Error("Forced test query failure.");
        if (callback) {
          process.nextTick(callback, error);
          return undefined;
        }
        return Promise.reject(error);
      }
      return originalQuery(...args);
    };

    client.release = function instrumentedRelease(...args) {
      if (!released) {
        released = true;
        state.active -= 1;
        client.query = originalQuery;
        client.release = originalRelease;
      }
      return originalRelease(...args);
    };

    return client;
  }

  pool.connect = function instrumentedConnect(...args) {
    const callback = typeof args[0] === "function" ? args[0] : null;
    if (!callback) {
      return originalConnect().then(instrumentClient);
    }

    return originalConnect(async (error, client) => {
      if (error) {
        callback(error);
        return;
      }
      try {
        const instrumented = await instrumentClient(client);
        callback(null, instrumented, instrumented.release);
      } catch (instrumentationError) {
        client.release();
        callback(instrumentationError);
      }
    });
  };

  return {
    state,
    reset() {
      state.active = 0;
      state.maxActive = 0;
      state.checkoutPids.length = 0;
      state.transactionPids.length = 0;
      state.queryTexts.length = 0;
      state.commitsUntilFailure = null;
      state.failQueryPattern = null;
    },
    failNextCommit() {
      state.commitsUntilFailure = 1;
    },
    failCommitNumber(number) {
      if (!Number.isInteger(number) || number < 1) {
        throw new TypeError("Commit number must be a positive integer.");
      }
      state.commitsUntilFailure = number;
    },
    failNextQueryMatching(pattern) {
      state.failQueryPattern = pattern;
    },
    restore() {
      pool.connect = originalConnect;
    }
  };
}
