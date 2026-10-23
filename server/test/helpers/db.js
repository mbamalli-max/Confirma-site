import pg from "pg";

const { Pool } = pg;

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
  await pool.query("TRUNCATE TABLE users, otp_challenges RESTART IDENTITY CASCADE");
}

export async function getBackendPid(client) {
  const result = await client.query("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0].pid);
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
    failCommit: false,
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
      if (state.failCommit && /^\s*COMMIT\b/i.test(String(text || ""))) {
        state.failCommit = false;
        const error = new Error("Forced test commit failure.");
        if (callback) {
          process.nextTick(callback, error);
          return undefined;
        }
        return Promise.reject(error);
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
      state.failCommit = false;
      state.failQueryPattern = null;
    },
    failNextCommit() {
      state.failCommit = true;
    },
    failNextQueryMatching(pattern) {
      state.failQueryPattern = pattern;
    },
    restore() {
      pool.connect = originalConnect;
    }
  };
}
