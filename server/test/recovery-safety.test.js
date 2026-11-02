import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closeAdminPools } from "../src/admin-db.js";
import { readOverview, rebuildRollups } from "../src/admin-metrics.js";
import { config, SERVER_LOGGER_OPTIONS } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { recoveryPartSha256 } from "../src/routes/recovery.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  applyRecoveryMigrations,
  buildRecoveryApp,
  createRecovery,
  ledgerEntry,
  recoveryPartDeclaration,
  resetRecoveryDatabase,
  seedRecoveryDevice
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
let app;
let capturedLogs = "";

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-safety-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-safety-receipt-secret";
  await applyRecoveryMigrations();
  app = await buildRecoveryApp({
    logger: {
      ...SERVER_LOGGER_OPTIONS,
      level: "info",
      stream: { write: (line) => { capturedLogs += String(line); } }
    }
  });
});

beforeEach(async () => {
  capturedLogs = "";
  await resetRecoveryDatabase();
});

after(async () => {
  await app.close();
  await closeAdminPools();
  await getPool().end();
});

test("holding-area payloads do not enter ledger rows, admin metrics, logs, or responses", async () => {
  const device = await seedRecoveryDevice({ status: "ACTIVE" });
  const rebuiltBefore = await rebuildRollups();
  assert.equal(rebuiltBefore.rebuilt, true);
  const metricsBefore = await readOverview({ range: "all" });
  const ledgerBefore = (await query("SELECT COUNT(*)::int AS n FROM ledger_entries")).rows[0].n;

  const { recoveryId, response: started } = await createRecovery(app, device);
  assert.equal(started.statusCode, 200);
  const privateMarker = `holding-private-${crypto.randomUUID()}`;
  const original = ledgerEntry(device, {
    normalized_label: privateMarker,
    counterparty: privateMarker
  });
  const payload = {
    records: [original],
    queue: [{ entry_payload: original, marker: privateMarker }]
  };
  const declaration = recoveryPartDeclaration([payload]);
  const uploaded = await app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/0`,
    headers: device.headers,
    payload: { sha256: recoveryPartSha256(payload), ...declaration, ...payload }
  });
  assert.equal(uploaded.statusCode, 200);

  const rebuiltAfter = await rebuildRollups();
  assert.equal(rebuiltAfter.rebuilt, true);
  const metricsAfter = await readOverview({ range: "all" });
  assert.deepEqual(metricsAfter, metricsBefore);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_entries")).rows[0].n, ledgerBefore);
  assert.doesNotMatch(uploaded.body, new RegExp(privateMarker));
  assert.doesNotMatch(JSON.stringify(metricsAfter), new RegExp(privateMarker));
  assert.doesNotMatch(capturedLogs, new RegExp(privateMarker));
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_parts")).rows[0].n, 1);
});
