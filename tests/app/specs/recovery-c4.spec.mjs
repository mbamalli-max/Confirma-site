import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { canonicalJson } from "../../../app-v3/recovery-client.js";
import {
  APP_API_URL,
  deviceStatusForIdentity,
  ensureCaptureScreen,
  ledgerEntriesForDevice,
  nextAccount,
  putStoreValue,
  readLocalState,
  recoveryPartsForSession,
  recoverySessionsForDevice,
  recoverySessionState,
  signInThroughUi,
  writeLocalState
} from "./helpers.mjs";

test.use({ serviceWorkers: "block" });

const ZERO_HASH = "0".repeat(64);
const SERVER_TIMEOUT = { timeout: 90_000 };
const LEGACY_APP_URL = process.env.APP_TEST_OLD_APP_URL || "http://127.0.0.1:5501";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// The old and current builds deliberately take turns on the same origin. That
// is what makes this a real v5 -> v6 IndexedDB upgrade instead of a copied or
// synthetic database fixture.
async function serveAppBuild(commit = null, appUrl = LEGACY_APP_URL) {
  let root = path.join(REPO_ROOT, "app-v3");
  if (commit) {
    const directory = mkdtempSync(path.join(tmpdir(), `konfirmata-c4-${commit}-`));
    const archive = execFileSync("git", ["-C", REPO_ROOT, "archive", commit, "app-v3"]);
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    root = path.join(directory, "app-v3");
  }
  const url = new URL(appUrl);
  const mime = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml"
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, url).pathname
      .replace(/^\/app(?:\/|$)/, "")
      .replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, pathname);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": mime[path.extname(file)] || "application/octet-stream"
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(Number(url.port), url.hostname, resolve));
  return server;
}

async function confirmRecord(page, amount, expectedStatus = 200) {
  await ensureCaptureScreen(page, { timeout: 10_000 });
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#confirm-append")).toBeEnabled();
  const response = page.waitForResponse((candidate) => (
    candidate.url().includes("/sync/entries") && candidate.request().method() === "POST"
  ), SERVER_TIMEOUT);
  await page.locator("#confirm-append").click();
  expect((await response).status()).toBe(expectedStatus);
  if (expectedStatus === 200) {
    await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, SERVER_TIMEOUT).toBe(0);
  }
}

async function installDamagedShape(page, rejectedSpecs, { preserveRecoveryMaterial = false } = {}) {
  return page.evaluate(async ({ rejectedSpecs, zeroHash, preserveRecoveryMaterial }) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = db.transaction(["settings", "records"], "readonly");
    const settingsRequest = read.objectStore("settings").getAll();
    const recordsRequest = read.objectStore("records").getAll();
    const [settingsRows, records] = await Promise.all([
      new Promise((resolve, reject) => {
        settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
        settingsRequest.onerror = () => reject(settingsRequest.error);
      }),
      new Promise((resolve, reject) => {
        recordsRequest.onsuccess = () => resolve(recordsRequest.result || []);
        recordsRequest.onerror = () => reject(recordsRequest.error);
      })
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const accepted = records
      .filter((row) => !row.importedFromServer && row.device_identity === settings.device_identity)
      .sort((left, right) => Number(left.id) - Number(right.id));
    if (!accepted.length) throw new Error("accepted fixture chain missing");
    const imported = accepted.map((record) => ({
      ...record,
      id: 1_000_000_000 + Number(record.id),
      server_entry_id: Number(record.id),
      importedFromServer: true
    }));
    const toHash = async (record) => {
      const canonical = [
        record.id, record.transaction_type, record.normalized_label, record.amount_minor,
        record.currency, record.counterparty, record.business_type_id, record.country,
        record.source_account, record.destination_account, record.reversed_entry_hash,
        record.reversed_transaction_type, record.confirmed_at, record.prev_entry_hash
      ].map((value) => value == null ? "" : String(value)).join("|");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const rejected = [];
    for (const [index, spec] of rejectedSpecs.entries()) {
      const previous = rejected.at(-1);
      const target = spec.reverses === "previous"
        ? previous?.entry_hash
        : (spec.reverses === "accepted" ? accepted.at(-1).entry_hash : null);
      const record = {
        ...accepted[0],
        id: index + 1,
        transaction_type: target ? "reversal" : "sale",
        normalized_label: spec.label || `c4_rejected_${index + 1}`,
        amount_minor: Number(spec.amountMinor || (900_000 + index)),
        confirmed_at: Number(spec.confirmedAt),
        prev_entry_hash: previous?.entry_hash || zeroHash,
        reversed_entry_hash: target || null,
        reversed_transaction_type: target ? "sale" : null,
        importedFromServer: false,
        evidence_level: "device_signed"
      };
      delete record.server_entry_id;
      delete record.restoredOwn;
      delete record.restoreVerified;
      record.entry_hash = await toHash(record);
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        settings.device_private_key,
        new TextEncoder().encode(record.entry_hash)
      );
      record.signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
      rejected.push(record);
    }
    const write = db.transaction(["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"], "readwrite");
    const settingsStore = write.objectStore("settings");
    const resetKeys = ["fork_recovery_pending", "fork_recovery_skips"];
    if (!preserveRecoveryMaterial) resetKeys.push("recovery_state", "recovery_history");
    for (const key of resetKeys) {
      settingsStore.delete(key);
    }
    const resetStores = ["records", "syncQueue"];
    if (!preserveRecoveryMaterial) resetStores.push("recoverySnapshots", "recoveryWork");
    for (const storeName of resetStores) {
      write.objectStore(storeName).clear();
    }
    imported.forEach((record) => write.objectStore("records").put(record));
    rejected.forEach((record) => {
      write.objectStore("records").put(record);
      write.objectStore("syncQueue").add({
        entry_id: record.id,
        entry_hash: record.entry_hash,
        device_identity: record.device_identity,
        status: "queued",
        attempt_count: 0,
        queued_at: Date.now(),
        entry_payload: record
      });
    });
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onabort = () => reject(write.error || new Error("damage fixture write aborted"));
      write.onerror = () => reject(write.error);
    });
    db.close();
    return {
      accepted: accepted.map((record) => ({
        id: record.id,
        entry_hash: record.entry_hash,
        confirmed_at: record.confirmed_at
      })),
      rejected: rejected.map((record) => ({
        id: record.id,
        entry_hash: record.entry_hash,
        confirmed_at: record.confirmed_at,
        reversed_entry_hash: record.reversed_entry_hash
      })),
      deviceIdentity: settings.device_identity
    };
  }, { rejectedSpecs, zeroHash: ZERO_HASH, preserveRecoveryMaterial });
}

async function sendQueuedOnce(page) {
  return page.evaluate(async (apiUrl) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["settings", "syncQueue"], "readonly");
    const settingsRequest = tx.objectStore("settings").getAll();
    const queueRequest = tx.objectStore("syncQueue").getAll();
    const [settingsRows, queue] = await Promise.all([
      new Promise((resolve, reject) => {
        settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
        settingsRequest.onerror = () => reject(settingsRequest.error);
      }),
      new Promise((resolve, reject) => {
        queueRequest.onsuccess = () => resolve(queueRequest.result || []);
        queueRequest.onerror = () => reject(queueRequest.error);
      })
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const response = await fetch(`${apiUrl}/sync/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.auth_token}`,
        "Content-Type": "application/json",
        "X-Device-Identity": settings.device_identity
      },
      body: JSON.stringify({
        device_identity: settings.device_identity,
        public_key: settings.device_public_key,
        entries: queue.map((item) => item.entry_payload)
      })
    });
    const body = await response.json();
    db.close();
    return { status: response.status, code: body.code || body.error || "" };
  }, APP_API_URL);
}

// Wait for a terminal recovery state and return the SAME snapshot that matched.
// When a previous incident's completed state is still stored (re-damage tests), pass
// its id in excludeRecoveryIds so a stale terminal state cannot satisfy the wait while
// the new incident has not begun yet (it made T-R2 fail once in a full run).
async function waitForRecoveryTerminal(page, { excludeRecoveryIds = [] } = {}) {
  let matched = null;
  await expect.poll(async () => {
    const local = await readLocalState(page);
    const recovery = local.settings.recovery_state;
    const terminal = /^(completed|escalated)$/.test(recovery?.state || "")
      && !excludeRecoveryIds.includes(recovery?.recovery_id);
    if (terminal) matched = local;
    return terminal ? recovery.state : (recovery?.state || "none");
  }, SERVER_TIMEOUT).toMatch(/^(completed|escalated)$/);
  return matched;
}

function recoveryWork(local) {
  const recoveryId = local.settings.recovery_state?.recovery_id;
  return local.stores.recoveryWork.find((item) => item.recovery_id === recoveryId);
}

function replacementBytes(local) {
  const work = recoveryWork(local);
  if (!work) return null;
  return canonicalJson((work.items || []).filter((item) => item.replacement).map((item) => item.replacement));
}

function expectContiguousLedger(deviceIdentity, expectedCount) {
  const ledger = ledgerEntriesForDevice(deviceIdentity);
  expect(ledger).toHaveLength(expectedCount);
  ledger.forEach((entry, index) => {
    expect(Number(entry.entry_id)).toBe(index + 1);
    expect(entry.prev_entry_hash).toBe(index === 0 ? ZERO_HASH : ledger[index - 1].entry_hash);
  });
  expect(new Set(ledger.map((entry) => entry.entry_hash)).size).toBe(ledger.length);
  return ledger;
}

async function setupOneRejectedRecovery(page, label) {
  await signInThroughUi(page, nextAccount(label));
  await confirmRecord(page, 8101);
  const confirmedAt = Math.floor(Date.now() / 1000) - 120;
  const fixture = await installDamagedShape(page, [{ confirmedAt, label: `${label}_rejected` }]);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  expect(deviceStatusForIdentity(fixture.deviceIdentity)?.status).toBe("FORKED");
  return fixture;
}

async function finishFirstRecovery(page, label) {
  const fixture = await setupOneRejectedRecovery(page, label);
  await page.reload();
  const completed = await waitForRecoveryTerminal(page);
  expect(completed.settings.recovery_state.state).toBe("completed");
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  await expect(page.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
  return { fixture, completed };
}

function recoveryStoreItem(local, storeName, recoveryId) {
  return local.stores[storeName].find((item) => item.recovery_id === recoveryId);
}

async function finishTwoRecoveries(page, label) {
  const first = await finishFirstRecovery(page, `${label}-first`);
  const firstState = structuredClone(first.completed.settings.recovery_state);
  const firstId = firstState.recovery_id;
  const firstSnapshotBytes = JSON.stringify(recoveryStoreItem(first.completed, "recoverySnapshots", firstId));
  const firstWorkBytes = JSON.stringify(recoveryStoreItem(first.completed, "recoveryWork", firstId));

  await confirmRecord(page, 8802);
  const beforeSecondDamage = await readLocalState(page);
  const freshAccepted = beforeSecondDamage.stores.records
    .filter((row) => !row.importedFromServer)
    .sort((left, right) => Number(left.id) - Number(right.id))
    .at(-1);
  expect(Number(freshAccepted.id)).toBe(3);

  const secondDate = Math.floor(Date.now() / 1000) - 30;
  const secondFixture = await installDamagedShape(page, [{
    confirmedAt: secondDate,
    label: `${label}_second_rejected`
  }], { preserveRecoveryMaterial: true });
  expect(secondFixture.accepted).toEqual(expect.arrayContaining([
    expect.objectContaining({ entry_hash: freshAccepted.entry_hash })
  ]));
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  const acceptedBeforeSecondHashes = ledgerEntriesForDevice(first.fixture.deviceIdentity)
    .map((row) => row.entry_hash);

  const secondRecoveryPaths = [];
  const secondSyncHashes = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/recovery/")) secondRecoveryPaths.push(pathname);
    if (pathname === "/sync/entries" && request.method() === "POST") {
      secondSyncHashes.push(...(request.postDataJSON()?.entries || []).map((entry) => entry.entry_hash));
    }
  });
  await page.reload();
  const second = await waitForRecoveryTerminal(page, { excludeRecoveryIds: [firstId] });
  expect(second.settings.recovery_state.state).toBe("completed");
  expect(second.settings.recovery_state.completion?.accounted_for).toBe(true);
  await expect(page.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
  return {
    deviceIdentity: first.fixture.deviceIdentity,
    firstFixture: first.fixture,
    secondFixture,
    firstState,
    firstId,
    secondId: second.settings.recovery_state.recovery_id,
    firstSnapshotBytes,
    firstWorkBytes,
    freshAccepted,
    acceptedBeforeSecondHashes,
    secondRecoveryPaths,
    secondSyncHashes,
    second
  };
}

async function seedAcceptedChain(page, count) {
  return page.evaluate(async ({ apiUrl, count, zeroHash }) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const settingsRequest = db.transaction("settings", "readonly").objectStore("settings").getAll();
    const settingsRows = await new Promise((resolve, reject) => {
      settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
      settingsRequest.onerror = () => reject(settingsRequest.error);
    });
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const profile = settings.profile || {};
    const hashRecord = async (record) => {
      const canonical = [
        record.id, record.transaction_type, record.normalized_label, record.amount_minor,
        record.currency, record.counterparty, record.business_type_id, record.country,
        record.source_account, record.destination_account, record.reversed_entry_hash,
        record.reversed_transaction_type, record.confirmed_at, record.prev_entry_hash
      ].map((value) => value == null ? "" : String(value)).join("|");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const records = [];
    let previousHash = zeroHash;
    const firstDate = Math.floor(Date.now() / 1000) - count - 600;
    for (let index = 0; index < count; index += 1) {
      const id = index + 1;
      const record = {
        id,
        transaction_type: "sale",
        normalized_label: `c4_large_history_${String(id).padStart(4, "0")}`,
        amount_minor: 100_000 + id,
        currency: "NGN",
        counterparty: null,
        business_type_id: profile.business_type_id || "ng_market_trader",
        country: profile.country || "NG",
        source_account: null,
        destination_account: null,
        reversed_entry_hash: null,
        reversed_transaction_type: null,
        confirmed_at: firstDate + index,
        prev_entry_hash: previousHash,
        device_identity: settings.device_identity,
        public_key_fingerprint: settings.device_key_fingerprint || null,
        evidence_level: "device_signed"
      };
      record.entry_hash = await hashRecord(record);
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        settings.device_private_key,
        new TextEncoder().encode(record.entry_hash)
      );
      record.signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
      records.push(record);
      previousHash = record.entry_hash;
    }
    for (let offset = 0; offset < records.length; offset += 25) {
      const response = await fetch(`${apiUrl}/sync/entries`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.auth_token}`,
          "Content-Type": "application/json",
          "X-Device-Identity": settings.device_identity
        },
        body: JSON.stringify({
          device_identity: settings.device_identity,
          public_key: settings.device_public_key,
          entries: records.slice(offset, offset + 25)
        })
      });
      if (!response.ok) throw new Error(`large history sync failed at ${offset}: ${response.status}`);
    }
    const write = db.transaction(["records", "syncQueue"], "readwrite");
    write.objectStore("records").clear();
    write.objectStore("syncQueue").clear();
    records.forEach((record) => write.objectStore("records").put(record));
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onabort = () => reject(write.error || new Error("large history local write aborted"));
      write.onerror = () => reject(write.error);
    });
    db.close();
    return {
      deviceIdentity: settings.device_identity,
      hashes: records.map((record) => record.entry_hash)
    };
  }, { apiUrl: APP_API_URL, count, zeroHash: ZERO_HASH });
}

test("C4 T1: a real v43 destructive restore upgrades in place and recovers its rejected record exactly once", async ({ browser }) => {
  test.slow();
  const legacyServer = await serveAppBuild("df65226");
  const context = await browser.newContext({ baseURL: LEGACY_APP_URL, serviceWorkers: "block" });
  const page = await context.newPage();
  let currentServer = null;
  try {
    await signInThroughUi(page, nextAccount("c4-real-v43"));
    await confirmRecord(page, 8201);
    const first = await readLocalState(page);
    const deviceIdentity = first.settings.device_identity;
    const accepted = first.stores.records.find((row) => !row.importedFromServer);

    await page.reload();
    await expect.poll(async () => {
      const local = await readLocalState(page);
      return {
        importedOwn: local.stores.records.filter((row) => (
          row.importedFromServer && row.device_identity === deviceIdentity
        )).length,
        own: local.stores.records.filter((row) => !row.importedFromServer).length
      };
    }, SERVER_TIMEOUT).toEqual({ importedOwn: 1, own: 0 });

    await confirmRecord(page, 8202, 409);
    const damaged = await readLocalState(page);
    const rejected = damaged.stores.syncQueue[0]?.entry_payload;
    expect(rejected).toBeDefined();
    expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("FORKED");

    await closeServer(legacyServer);
    currentServer = await serveAppBuild();
    let recordPageRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/records" && url.searchParams.has("offset")) recordPageRequests += 1;
    });
    await page.reload();
    const after = await waitForRecoveryTerminal(page);
    expect(recordPageRequests).toBeGreaterThan(0);
    expect(after.settings.recovery_state.state).toBe("completed");
    expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
    const snapshot = after.stores.recoverySnapshots[0];
    expect(snapshot.records.find((row) => row.entry_hash === accepted.entry_hash)).toEqual(expect.objectContaining({
      signature: accepted.signature,
      confirmed_at: accepted.confirmed_at,
      amount_minor: accepted.amount_minor,
      importedFromServer: true
    }));
    const preservedRejected = snapshot.records.find((row) => row.entry_hash === rejected.entry_hash);
    expect(preservedRejected).toEqual(expect.objectContaining({
      signature: rejected.signature,
      confirmed_at: rejected.confirmed_at,
      amount_minor: rejected.amount_minor
    }));
    // A row the v43 app created itself never carried the import flag at all, so
    // the property is absent (not false). What matters is that it is not an import.
    expect(preservedRejected.importedFromServer).not.toBe(true);
    const recovered = recoveryWork(after).items.find((item) => item.original.entry_hash === rejected.entry_hash);
    expect(recovered.replacement.id).toBe(2);
    const ledger = expectContiguousLedger(deviceIdentity, 2);
    expect(ledger.filter((row) => row.entry_hash === accepted.entry_hash)).toHaveLength(1);
    // Match on amount as well: the accepted and rejected records can be created in the
    // same second, so confirmed_at alone is not unique to the recovered record.
    expect(ledger.filter((row) => Number(row.payload.confirmed_at) === Number(rejected.confirmed_at)
      && Number(row.payload.amount_minor) === Number(rejected.amount_minor))).toHaveLength(1);
    expect(Number(ledger[1].payload.confirmed_at)).toBe(Number(rejected.confirmed_at));
    await expect(page.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
  } finally {
    await context.close();
    if (currentServer) await closeServer(currentServer);
    else if (legacyServer.listening) await closeServer(legacyServer);
  }
});

test("C4 T1b: a healthy released v44 database upgrades byte-identically without recovery", async ({ browser }) => {
  test.slow();
  const legacyServer = await serveAppBuild("d89756e");
  const context = await browser.newContext({ baseURL: LEGACY_APP_URL, serviceWorkers: "block" });
  const page = await context.newPage();
  let currentServer = null;
  try {
    await signInThroughUi(page, nextAccount("c4-healthy-v44"));
    await confirmRecord(page, 8211);
    const before = await readLocalState(page);
    const beforeBytes = JSON.stringify({
      records: before.stores.records,
      queue: before.stores.syncQueue
    });
    await page.addInitScript(() => {
      window.__c4RecoveryStateWrites = 0;
      const originalPut = IDBObjectStore.prototype.put;
      const originalAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.put = function patchedPut(value, key) {
        if (this.name === "settings" && value?.key === "recovery_state") window.__c4RecoveryStateWrites += 1;
        return originalPut.call(this, value, key);
      };
      IDBObjectStore.prototype.add = function patchedAdd(value, key) {
        if (this.name === "settings" && value?.key === "recovery_state") window.__c4RecoveryStateWrites += 1;
        return originalAdd.call(this, value, key);
      };
    });
    await closeServer(legacyServer);
    currentServer = await serveAppBuild();
    let recoveryRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
    });
    await page.reload();
    await expect(page.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    const after = await readLocalState(page);
    expect(JSON.stringify({ records: after.stores.records, queue: after.stores.syncQueue })).toBe(beforeBytes);
    expect(recoveryRequests).toBe(0);
    expect(await page.evaluate(() => window.__c4RecoveryStateWrites)).toBe(0);
    expect(after.settings.recovery_state).toBeUndefined();
    expect(await page.locator("#recovery-hold-banner").count()).toBe(0);
  } finally {
    await context.close();
    if (currentServer) await closeServer(currentServer);
    else if (legacyServer.listening) await closeServer(legacyServer);
  }
});

test("C4 T2a/T2b/T2d: 1001 accepted rows use multiple snapshot parts and record pages without replay", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c4-large-history"));
  const seeded = await seedAcceptedChain(page, 1001);
  const acceptedHashes = new Set(seeded.hashes);
  const dates = [Math.floor(Date.now() / 1000) - 90, Math.floor(Date.now() / 1000) - 60];
  const fixture = await installDamagedShape(page, [
    { confirmedAt: dates[0], label: "c4_large_rejected_1" },
    { confirmedAt: dates[1], label: "c4_large_rejected_2" }
  ]);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });

  const recordOffsets = [];
  const replacementSyncPayloads = [];
  const acknowledgedParts = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/records" && url.searchParams.has("offset")) {
      recordOffsets.push(Number(url.searchParams.get("offset")));
    }
    if (url.pathname === "/sync/entries" && request.method() === "POST") {
      replacementSyncPayloads.push(request.postDataJSON()?.entries || []);
    }
  });
  page.on("response", (response) => {
    const match = new URL(response.url()).pathname.match(/\/recovery\/sessions\/[^/]+\/parts\/(\d+)$/);
    if (match && response.request().method() === "PUT" && response.status() === 200) {
      acknowledgedParts.push(Number(match[1]));
    }
  });

  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("completed");
  expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
  const recoveryId = after.settings.recovery_state.recovery_id;
  const declared = after.settings.recovery_state.cursor?.parts || [];
  const storedParts = recoveryPartsForSession(recoveryId);
  expect(declared.length).toBeGreaterThan(1);
  expect(storedParts.length).toBe(declared.length);
  expect(storedParts.map((part) => Number(part.part_no))).toEqual(declared.map((part) => part.part_no));
  expect(new Set(acknowledgedParts)).toEqual(new Set(declared.map((part) => part.part_no)));
  expect(new Set(recordOffsets).size).toBeGreaterThan(1);
  expect(recordOffsets).toEqual(expect.arrayContaining([0, 1000]));

  const allRecoverySessionSyncEntries = replacementSyncPayloads.flat();
  const recoveryEntries = allRecoverySessionSyncEntries.filter((entry) => Number(entry.id) > 1001);
  expect(recoveryEntries).toHaveLength(2);
  expect(allRecoverySessionSyncEntries.some((entry) => acceptedHashes.has(entry.entry_hash))).toBe(false);
  const work = recoveryWork(after);
  expect(work.manifest.items.filter((item) => item.disposition === "accepted")).toHaveLength(1001);
  expect(work.manifest.items.filter((item) => item.disposition === "replaced")).toHaveLength(2);
  const ledger = expectContiguousLedger(fixture.deviceIdentity, 1003);
  expect(ledger.filter((entry) => acceptedHashes.has(entry.entry_hash))).toHaveLength(1001);
  expect(new Set(ledger.filter((entry) => acceptedHashes.has(entry.entry_hash)).map((entry) => entry.entry_hash)).size)
    .toBe(1001);
});

test("C4 T3: rejected reversal replacements remap to the first replacement and preserve both dates", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c4-reversal-remap"));
  await confirmRecord(page, 8301);
  const dates = [Math.floor(Date.now() / 1000) - 300, Math.floor(Date.now() / 1000) - 240];
  const fixture = await installDamagedShape(page, [
    { confirmedAt: dates[0], label: "c4_reversal_source" },
    { confirmedAt: dates[1], label: "c4_reversal_of_rejected", reverses: "previous" }
  ]);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
  const items = recoveryWork(after).items.filter((item) => item.replacement);
  expect(items).toHaveLength(2);
  expect(items[1].replacement.reversed_entry_hash).toBe(items[0].replacement.entry_hash);
  expect(items[1].replacement.reversed_entry_hash).not.toBe(items[0].original.entry_hash);
  expect(items.map((item) => item.replacement.confirmed_at)).toEqual(dates);
  const ledger = expectContiguousLedger(fixture.deviceIdentity, 3);
  expect(ledger[2].payload.reversed_entry_hash).toBe(ledger[1].entry_hash);
  expect(fixture.rejected.some((original) => original.entry_hash === ledger[2].payload.reversed_entry_hash)).toBe(false);
});

test("C4 T3b: a recovered reversal of an accepted record keeps the accepted hash unchanged", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c4-reversal-accepted"));
  await confirmRecord(page, 8311);
  const confirmedAt = Math.floor(Date.now() / 1000) - 180;
  const fixture = await installDamagedShape(page, [
    { confirmedAt, label: "c4_reversal_of_accepted", reverses: "accepted" }
  ]);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
  const item = recoveryWork(after).items.find((candidate) => candidate.replacement);
  expect(item.replacement.reversed_entry_hash).toBe(fixture.accepted[0].entry_hash);
  expect(item.replacement.confirmed_at).toBe(confirmedAt);
  const ledger = expectContiguousLedger(fixture.deviceIdentity, 2);
  expect(ledger[1].payload.reversed_entry_hash).toBe(ledger[0].entry_hash);
});

test("C4 T4: before-2000, beyond-bound and normal rejected dates are classified and preserved end to end", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c4-date-classes"));
  await confirmRecord(page, 8401);
  const dates = [915_148_800, Math.floor(Date.now() / 1000) + (3 * 86_400), Math.floor(Date.now() / 1000) - 60];
  const fixture = await installDamagedShape(page, [
    { confirmedAt: dates[0], label: "c4_before_2000" },
    { confirmedAt: dates[1], label: "c4_after_receipt_bound" },
    { confirmedAt: dates[2], label: "c4_normal_date" }
  ]);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("completed");
  expect(after.settings.recovery_state.completion).toEqual(expect.objectContaining({ accounted_for: true }));
  const items = recoveryWork(after).items.filter((item) => item.replacement);
  expect(items.map((item) => item.date_check)).toEqual(["before_2000", "after_receipt_bound", "ok"]);
  expect(items.map((item) => item.replacement.confirmed_at)).toEqual(dates);
  expect(items.every((item) => item.not_replaceable === false)).toBe(true);
  const ledger = expectContiguousLedger(fixture.deviceIdentity, 4);
  expect(ledger.slice(1).map((row) => Number(row.payload.confirmed_at))).toEqual(dates);
  expect(recoveryWork(after).manifest.items.filter((item) => (
    ["unexplained", "unrepresentable"].includes(item.disposition)
  ))).toEqual([]);
});

const CHECKPOINTS = [
  { name: "snapshot-written", pattern: "**/recovery/sessions/*/parts/*", state: "snapshotted" },
  { name: "plan-accepted", pattern: "**/recovery/sessions/*/plan", state: "classified", fetchFirst: true, serverState: "planned" },
  { name: "replacements-rebuilt", pattern: "**/sync/entries", state: "rebuilt" },
  { name: "replacements-synced", pattern: "**/records**", state: "synced", recordsOnly: true },
  { name: "before-completion", pattern: "**/recovery/sessions/*/complete", state: "verified" }
];

for (const checkpoint of CHECKPOINTS) {
  test(`C4 T5 checkpoint ${checkpoint.name}: close at the held boundary and resume without duplicate replacements`, async ({ browser }) => {
    test.slow();
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      serviceWorkers: "block"
    });
    let page = await context.newPage();
    try {
      const fixture = await setupOneRejectedRecovery(page, `c4-checkpoint-${checkpoint.name}`);
      let interceptionCount = 0;
      let heldEvidence = null;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let heldResolve;
      const held = new Promise((resolve) => { heldResolve = resolve; });
      await page.route(checkpoint.pattern, async (route) => {
        interceptionCount += 1;
        if (checkpoint.recordsOnly) {
          const url = new URL(route.request().url());
          if (url.pathname !== "/records" || !url.searchParams.has("offset")) {
            await route.continue();
            return;
          }
          const observed = await readLocalState(page);
          if (observed.settings.recovery_state?.state !== checkpoint.state) {
            await route.continue();
            return;
          }
        }
        const response = checkpoint.fetchFirst ? await route.fetch() : null;
        const local = await readLocalState(page);
        const recoveryId = local.settings.recovery_state?.recovery_id;
        heldEvidence = {
          local,
          server: recoveryId ? recoverySessionState(recoveryId) : null,
          parts: recoveryId ? recoveryPartsForSession(recoveryId) : []
        };
        heldResolve();
        await gate;
        try {
          if (page.isClosed()) await route.abort();
          else if (response) await route.fulfill({ response });
          else await route.continue();
        } catch {
          // Closing the page is the interruption under test; its held request
          // is expected to disappear before the route can be released.
        }
      });

      const reload = page.reload().catch(() => null);
      await held;
      expect(interceptionCount).toBeGreaterThan(0);
      expect(heldEvidence.local.settings.recovery_state?.state).toBe(checkpoint.state);
      expect(heldEvidence.local.stores.recoverySnapshots).toHaveLength(1);
      if (checkpoint.name === "snapshot-written") {
        expect(heldEvidence.parts).toEqual([]);
      }
      if (checkpoint.serverState) expect(heldEvidence.server?.state).toBe(checkpoint.serverState);
      const savedBytesBeforeClose = replacementBytes(heldEvidence.local);

      await page.close();
      release();
      await reload;

      page = await context.newPage();
      let resumedSyncInterceptions = 0;
      let firstSavedBytes = savedBytesBeforeClose;
      if (!firstSavedBytes) {
        await page.route("**/sync/entries", async (route) => {
          resumedSyncInterceptions += 1;
          const local = await readLocalState(page);
          firstSavedBytes = replacementBytes(local);
          await route.continue();
        });
      }
      await page.goto("/");
      const after = await waitForRecoveryTerminal(page);
      if (!savedBytesBeforeClose) expect(resumedSyncInterceptions).toBeGreaterThan(0);
      expect(firstSavedBytes).not.toBeNull();
      expect(replacementBytes(after)).toBe(firstSavedBytes);
      expect(after.settings.recovery_state.state).toBe("completed");
      expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
      const work = recoveryWork(after);
      const uploadedHashes = new Set([
        ...after.stores.recoverySnapshots[0].records.map((row) => row.entry_hash),
        ...after.stores.recoverySnapshots[0].queue.map((row) => row.entry_payload?.entry_hash)
      ]);
      expect(new Set(work.manifest.items.map((item) => item.original_entry_hash))).toEqual(uploadedHashes);
      expectContiguousLedger(fixture.deviceIdentity, 2);
      await expect(page.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
    } finally {
      await context.close();
    }
  });
}

test("C3 redamage T-R1: a completed device gets a distinct second recovery without replaying the first incident", async ({ page }) => {
  test.slow();
  const result = await finishTwoRecoveries(page, "c3-redamage-r1");
  expect(result.secondId).not.toBe(result.firstId);

  const history = result.second.settings.recovery_history;
  expect(history).toHaveLength(1);
  expect(canonicalJson(history[0])).toBe(canonicalJson(result.firstState));
  expect(JSON.stringify(recoveryStoreItem(result.second, "recoverySnapshots", result.firstId)))
    .toBe(result.firstSnapshotBytes);
  expect(JSON.stringify(recoveryStoreItem(result.second, "recoveryWork", result.firstId)))
    .toBe(result.firstWorkBytes);
  expect(result.second.stores.recoverySnapshots).toHaveLength(2);
  expect(result.second.stores.recoveryWork).toHaveLength(2);

  const secondSnapshot = recoveryStoreItem(result.second, "recoverySnapshots", result.secondId);
  expect(secondSnapshot.records).toEqual(expect.arrayContaining([
    expect.objectContaining({
      entry_hash: result.freshAccepted.entry_hash,
      server_entry_id: result.freshAccepted.id,
      id: 1_000_000_000 + Number(result.freshAccepted.id),
      importedFromServer: true
    })
  ]));

  const sessions = recoverySessionsForDevice(result.deviceIdentity);
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map((session) => session.recovery_id))).toEqual(new Set([result.firstId, result.secondId]));
  expect(sessions.every((session) => session.state === "completed")).toBe(true);

  const firstWork = recoveryStoreItem(result.second, "recoveryWork", result.firstId);
  const secondWork = recoveryStoreItem(result.second, "recoveryWork", result.secondId);
  const firstRecovered = firstWork.items.find((item) => (
    item.original.entry_hash === result.firstFixture.rejected[0].entry_hash
  ));
  const secondRecovered = secondWork.items.find((item) => (
    item.original.entry_hash === result.secondFixture.rejected[0].entry_hash
  ));
  const ledger = expectContiguousLedger(result.deviceIdentity, 4);
  for (const [planned, original] of [
    [firstRecovered, result.firstFixture.rejected[0]],
    [secondRecovered, result.secondFixture.rejected[0]]
  ]) {
    expect(ledger.filter((row) => row.entry_hash === planned.replacement.entry_hash)).toHaveLength(1);
    expect(Number(ledger.find((row) => row.entry_hash === planned.replacement.entry_hash).payload.confirmed_at))
      .toBe(Number(original.confirmed_at));
  }
  expect(new Set(ledger.map((row) => row.entry_hash)).size).toBe(ledger.length);
  expect(result.secondSyncHashes).toEqual([secondRecovered.replacement.entry_hash]);
  expect(result.secondSyncHashes.some((hash) => result.acceptedBeforeSecondHashes.includes(hash))).toBe(false);
  expect(result.secondRecoveryPaths.filter((pathname) => pathname.includes(result.firstId))).toEqual([]);
});

test("C3 redamage T-R2: a healthy reload after the second completion makes no recovery request or state write", async ({ page }) => {
  test.slow();
  const result = await finishTwoRecoveries(page, "c3-redamage-r2");
  const completedBytes = canonicalJson(result.second.settings.recovery_state);
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  await page.addInitScript(() => {
    window.__redamageRecoveryStateWrites = 0;
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__redamageRecoveryStateWrites += 1;
      return originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__redamageRecoveryStateWrites += 1;
      return originalAdd.call(this, value, key);
    };
  });

  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
  const after = await readLocalState(page);
  expect(recoveryRequests).toBe(0);
  expect(await page.evaluate(() => window.__redamageRecoveryStateWrites)).toBe(0);
  expect(canonicalJson(after.settings.recovery_state)).toBe(completedBytes);
});

test("C3 redamage T-R3: two tabs racing archive once and admit exactly one new incident", async ({ page }) => {
  test.slow();
  const first = await finishFirstRecovery(page, "c3-redamage-r3-first");
  const firstId = first.completed.settings.recovery_state.recovery_id;
  const peer = await page.context().newPage();
  await peer.goto("/");
  await expect(peer.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);

  await confirmRecord(page, 8833);
  const damaged = await installDamagedShape(page, [{
    confirmedAt: Math.floor(Date.now() / 1000) - 25,
    label: "c3_redamage_race_rejected"
  }], { preserveRecoveryMaterial: true });
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });

  let sessionRequests = 0;
  let runner = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const holdFirstSession = (candidate) => async (route) => {
    sessionRequests += 1;
    if (sessionRequests === 1) {
      runner = candidate;
      enteredResolve();
      await gate;
    }
    await route.continue();
  };
  await page.route("**/recovery/sessions", holdFirstSession(page));
  await peer.route("**/recovery/sessions", holdFirstSession(peer));

  const reloads = [page.reload().catch(() => null), peer.reload().catch(() => null)];
  await entered;
  expect(sessionRequests).toBe(1);
  const during = await readLocalState(runner);
  const secondId = during.settings.recovery_state.recovery_id;
  expect(secondId).not.toBe(firstId);
  expect(during.settings.recovery_history).toHaveLength(1);
  expect(during.settings.recovery_history[0].recovery_id).toBe(firstId);
  expect(during.stores.recoverySnapshots.filter((item) => item.recovery_id === secondId)).toHaveLength(1);

  release();
  // Do not unroute here: the held handler is still about to call route.continue(),
  // and removing the route first makes that call fail with "Route is already handled".
  await Promise.all(reloads);
  const after = await waitForRecoveryTerminal(runner, { excludeRecoveryIds: [firstId] });
  expect(after.settings.recovery_state.recovery_id).toBe(secondId);
  expect(after.settings.recovery_state.completion?.accounted_for).toBe(true);
  expect(after.settings.recovery_history).toHaveLength(1);
  expect(recoverySessionsForDevice(damaged.deviceIdentity).map((session) => session.recovery_id))
    .toEqual([firstId, secondId]);
  await expect(runner.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
  await page.unroute("**/recovery/sessions", { behavior: "ignoreErrors" });
  await peer.unroute("**/recovery/sessions", { behavior: "ignoreErrors" });
  await peer.close();
});

test("C3 redamage T-R4: a session change after detection cannot archive or replace the completed incident", async ({ page }) => {
  test.slow();
  const first = await finishFirstRecovery(page, "c3-redamage-r4-first");
  const completedBytes = canonicalJson(first.completed.settings.recovery_state);
  const snapshotsBytes = JSON.stringify(first.completed.stores.recoverySnapshots);
  const workBytes = JSON.stringify(first.completed.stores.recoveryWork);
  await confirmRecord(page, 8844);
  await installDamagedShape(page, [{
    confirmedAt: Math.floor(Date.now() / 1000) - 20,
    label: "c3_redamage_session_guard"
  }], { preserveRecoveryMaterial: true });
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });

  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  await page.addInitScript(() => {
    window.__redamageFingerprintEntered = false;
    window.__redamageRecoveryStateWrites = 0;
    let releaseFingerprint;
    window.__redamageFingerprintGate = new Promise((resolve) => { releaseFingerprint = resolve; });
    window.__releaseRedamageFingerprint = releaseFingerprint;
    const originalDigest = SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest = async function patchedDigest(algorithm, data) {
      const text = new TextDecoder().decode(data);
      if (!window.__redamageFingerprintEntered && text.includes('"entry_hashes"') && text.includes('"reasons"')) {
        window.__redamageFingerprintEntered = true;
        await window.__redamageFingerprintGate;
      }
      return originalDigest.call(this, algorithm, data);
    };
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__redamageRecoveryStateWrites += 1;
      return originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__redamageRecoveryStateWrites += 1;
      return originalAdd.call(this, value, key);
    };
  });

  const reload = page.reload().catch(() => null);
  await page.waitForFunction(() => window.__redamageFingerprintEntered === true, null, SERVER_TIMEOUT);
  await writeLocalState(page, {
    auth_token: "",
    auth_token_expires_at: "",
    signed_out: true,
    session_generation: Number(first.completed.settings.session_generation || 0) + 1
  });
  await page.evaluate(() => window.__releaseRedamageFingerprint());
  await reload;
  const after = await readLocalState(page);
  expect(canonicalJson(after.settings.recovery_state)).toBe(completedBytes);
  expect(after.settings.recovery_history).toBeUndefined();
  expect(JSON.stringify(after.stores.recoverySnapshots)).toBe(snapshotsBytes);
  expect(JSON.stringify(after.stores.recoveryWork)).toBe(workBytes);
  expect(await page.evaluate(() => window.__redamageRecoveryStateWrites)).toBe(0);
  expect(recoveryRequests).toBe(0);
  expect(recoverySessionsForDevice(first.fixture.deviceIdentity)).toHaveLength(1);
});

test("C3 redamage T-R5: fingerprint suffix guard escalates the fourth identical detection without a server session", async ({ page }) => {
  await signInThroughUi(page, nextAccount("c3-redamage-loop-guard"));
  const local = await readLocalState(page);
  const fingerprintCheck = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-client.js");
    const first = await recovery.buildDetectionFingerprint({
      reasons: ["own_imported_copy", "hash_chain_break"],
      entryHashes: ["b".repeat(64), "a".repeat(64)]
    });
    const reordered = await recovery.buildDetectionFingerprint({
      reasons: ["hash_chain_break", "own_imported_copy", "hash_chain_break"],
      entryHashes: ["a".repeat(64), "b".repeat(64), "a".repeat(64)]
    });
    const changed = await recovery.buildDetectionFingerprint({
      reasons: ["own_imported_copy"],
      entryHashes: ["a".repeat(64), "b".repeat(64)]
    });
    return { first, reordered, changed, limit: recovery.MAX_CONSECUTIVE_IDENTICAL_RECOVERIES };
  });
  expect(fingerprintCheck.reordered).toBe(fingerprintCheck.first);
  expect(fingerprintCheck.changed).not.toBe(fingerprintCheck.first);
  expect(fingerprintCheck.limit).toBe(3);

  const ids = [
    "00000000-0000-4000-8000-000000000101",
    "00000000-0000-4000-8000-000000000102",
    "00000000-0000-4000-8000-000000000103"
  ];
  const completed = ids.map((recoveryId, index) => ({
    recovery_id: recoveryId,
    state: "completed",
    started_at: 1000 + index,
    device_identity: local.settings.device_identity,
    bound_account: local.settings.bound_account,
    detection_fingerprint: fingerprintCheck.first,
    cursor: null,
    attempts: 0,
    remote_ack: true,
    completion: { outcome: "not_cleared", accounted_for: true, reasons: ["autoclear_disabled"] }
  }));
  await writeLocalState(page, {
    recovery_history: completed.slice(0, 2),
    recovery_state: completed[2]
  });
  for (const recoveryId of ids) {
    await putStoreValue(page, "recoverySnapshots", {
      recovery_id: recoveryId,
      device_identity: local.settings.device_identity,
      records: [{ entry_hash: recoveryId.replaceAll("-", "").padEnd(64, "0") }],
      queue: [],
      read_back_verified: true
    });
    await putStoreValue(page, "recoveryWork", { recovery_id: recoveryId, items: [] });
  }
  const before = await readLocalState(page);
  const evidenceBefore = JSON.stringify({
    snapshots: before.stores.recoverySnapshots,
    work: before.stores.recoveryWork
  });
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  const nextId = "00000000-0000-4000-8000-000000000104";
  const next = await page.evaluate(async ({ nextId, fingerprint }) => {
    const recovery = await import("/app/recovery-client.js");
    const request = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = db.transaction("settings", "readonly").objectStore("settings");
    const keys = ["session_generation", "wipe_epoch", "bound_account", "auth_token", "recovery_state"];
    const rows = await Promise.all(keys.map((key) => new Promise((resolve, reject) => {
      const get = read.get(key);
      get.onsuccess = () => resolve(get.result?.value);
      get.onerror = () => reject(get.error);
    })));
    const [sessionGeneration, wipeEpoch, boundAccount, authToken, expectedCompletedState] = rows;
    const value = await recovery.beginRecoveryState(db, {
      recoveryId: nextId,
      deviceIdentity: expectedCompletedState.device_identity,
      boundAccount,
      reasons: ["own_imported_copy", "hash_chain_break"],
      detectionFingerprint: fingerprint,
      expectedCompletedState,
      guard: {
        sessionGeneration: Number(sessionGeneration || 0),
        wipeEpoch: Number(wipeEpoch || 0),
        boundAccount,
        authToken
      }
    });
    db.close();
    return value;
  }, { nextId, fingerprint: fingerprintCheck.first });
  expect(next).toEqual(expect.objectContaining({ recovery_id: nextId, state: "escalated" }));
  const after = await readLocalState(page);
  expect(after.settings.recovery_history).toHaveLength(3);
  expect(canonicalJson(after.settings.recovery_history[2])).toBe(canonicalJson(completed[2]));
  expect(JSON.stringify({
    snapshots: after.stores.recoverySnapshots,
    work: after.stores.recoveryWork
  })).toBe(evidenceBefore);
  await page.reload();
  await expect(page.locator("#recovery-hold-banner")).toHaveText(
    "Your records are preserved. We need to finish repairing this on our side."
  );
  const held = await readLocalState(page);
  expect(held.settings.recovery_state).toEqual(expect.objectContaining({
    recovery_id: nextId,
    state: "escalated"
  }));
  expect(JSON.stringify({
    snapshots: held.stores.recoverySnapshots,
    work: held.stores.recoveryWork
  })).toBe(evidenceBefore);
  expect(recoveryRequests).toBe(0);
  expect(recoverySessionState(nextId)).toBeNull();
});

test("C3 redamage T-R6: recovery history alone triggers the removal warning and is wiped atomically", async ({ page }) => {
  await page.goto("/");
  await writeLocalState(page, {
    bound_account: "fixture-redamage-account",
    signed_out: true,
    recovery_history: [{
      recovery_id: "00000000-0000-4000-8000-000000000201",
      state: "completed",
      device_identity: "fixture-redamage-device",
      bound_account: "fixture-redamage-account",
      detection_fingerprint: "f".repeat(64),
      completion: { accounted_for: true }
    }]
  });
  await page.reload();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await page.locator("#signed-out-remove-data").click();
  await expect(page.locator("#remove-local-data-copy")).toContainText(
    "Recovery material for a syncing repair is also stored on this device"
  );
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  const after = await readLocalState(page);
  expect(after.settings.recovery_history).toBeUndefined();
  expect(after.settings.recovery_state).toBeUndefined();
  expect(after.stores.recoverySnapshots).toEqual([]);
  expect(after.stores.recoveryWork).toEqual([]);
});
