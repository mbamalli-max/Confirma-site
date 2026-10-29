import { expect, test } from "@playwright/test";
import {
  clearStore, installIdbFault, ledgerEntriesForDevice, nextAccount, preSliceAToken, readLocalState,
  signInThroughUi, writeLocalState
} from "./helpers.mjs";

// T3: a confirmed record and its sync-queue entry are written together, and
// records an older version saved without a queue entry are queued once.

// Test-process fault hooks (not app code). Each page gets its own window flags.
async function installT3Faults(page, { removeLocks = false } = {}) {
  await page.addInitScript(({ removeLocks: noLocks }) => {
    if (noLocks) {
      Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true });
    }
    window.__t3 = {
      failQueueAdd: false,
      failUsage: false,
      holdSign: false,
      signHeld: false,
      release: null,
      signCount: 0,
      attestBeforeRepairId: null,
      settingBeforeRepair: null
    };
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      const request = originalAdd.call(this, value, key);
      if (this.name === "syncQueue" && window.__t3.failQueueAdd) {
        window.__t3.failQueueAdd = false;
        const tx = this.transaction;
        queueMicrotask(() => tx.abort());
      }
      return request;
    };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "usage" && window.__t3.failUsage) {
        window.__t3.failUsage = false;
        throw new DOMException("Forced usage failure.", "DataError");
      }
      return originalPut.call(this, value, key);
    };
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function patchedTransaction(storeNames, mode, options) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const isRepairWrite = mode === "readwrite" && names.length === 3
        && ["settings", "records", "syncQueue"].every((name) => names.includes(name))
        && String(new Error().stack).includes("repairUnqueuedRecords");
      const setting = window.__t3?.settingBeforeRepair;
      if (setting && isRepairWrite) {
        // Another tab's sign-out or removal commits between repair's scan and its write.
        window.__t3.settingBeforeRepair = null;
        const other = originalTransaction.call(this, ["settings"], "readwrite");
        originalPut.call(other.objectStore("settings"), { key: setting.key, value: setting.value });
      }
      const recordId = window.__t3?.attestBeforeRepairId;
      if (recordId && mode === "readwrite" && names.length === 3
          && ["settings", "records", "syncQueue"].every((name) => names.includes(name))
          && String(new Error().stack).includes("repairUnqueuedRecords")) {
        // Simulate a sync commit landing after repair's scan but before its
        // transaction: this earlier readwrite transaction runs first.
        window.__t3.attestBeforeRepairId = null;
        const mark = originalTransaction.call(this, ["records"], "readwrite");
        const store = mark.objectStore("records");
        const get = store.get(recordId);
        get.onsuccess = () => {
          const record = get.result;
          if (!record) return;
          record.evidence_level = "server_attested";
          record.server_entry_id = record.id;
          originalPut.call(store, record);
        };
      }
      return originalTransaction.call(this, storeNames, mode, options);
    };
    const originalSign = SubtleCrypto.prototype.sign;
    SubtleCrypto.prototype.sign = async function patchedSign(...args) {
      window.__t3.signCount += 1;
      if (window.__t3.holdSign) {
        window.__t3.holdSign = false;
        window.__t3.signHeld = true;
        await new Promise((resolve) => { window.__t3.release = resolve; });
      }
      return originalSign.apply(this, args);
    };
  }, { removeLocks });
}

async function setT3(page, values) {
  await page.evaluate((next) => Object.assign(window.__t3, next), values);
}

async function blockSync(page) {
  await page.route("**/sync/entries", (route) => route.abort("connectionrefused"));
}

async function unblockSync(page) {
  await page.unroute("**/sync/entries");
}

async function prepareRecord(page, amount) {
  if (!(await page.locator("#screen-capture.active").isVisible())) {
    await page.locator("#nav-record-v2").click();
  }
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#confirm-append")).toBeEnabled();
}

async function confirmRecord(page, amount) {
  await prepareRecord(page, amount);
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
}

async function deleteQueueEntryFor(page, entryHash) {
  await page.evaluate(async (hash) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("confirma-v3-db", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("syncQueue", "readwrite");
      const store = tx.objectStore("syncQueue");
      const all = store.getAll();
      all.onsuccess = () => all.result.filter((item) => item.entry_hash === hash).forEach((item) => store.delete(item.queue_id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, entryHash);
}

async function armBeforeNextLoad(page, key, value) {
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [key, value]);
}

function ownRecords(local) {
  return local.stores.records.filter((record) => !record.importedFromServer).sort((a, b) => a.id - b.id);
}

async function openSecondPage(context, options) {
  const pageB = await context.newPage();
  await installIdbFault(pageB);
  await installT3Faults(pageB, options);
  await pageB.goto("/");
  await expect(pageB.locator("#screen-capture.active")).toBeVisible();
  return pageB;
}

test.beforeEach(async ({ page }) => {
  await installIdbFault(page);
  await installT3Faults(page);
  // A value armed in sessionStorage applies to the next page load only.
  await page.addInitScript(() => {
    const setting = sessionStorage.getItem("__t3SettingBeforeRepair");
    if (setting) {
      sessionStorage.removeItem("__t3SettingBeforeRepair");
      window.__t3.settingBeforeRepair = JSON.parse(setting);
    }
  });
});

test("Q1 a confirmed record has exactly one queue entry with its hash, and it syncs", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q1"));
  await blockSync(page);
  await confirmRecord(page, 3101);
  const local = await readLocalState(page);
  const [record] = ownRecords(local);
  expect(local.stores.syncQueue).toHaveLength(1);
  expect(local.stores.syncQueue[0].entry_hash).toBe(record.entry_hash);
  expect(local.stores.syncQueue[0].entry_payload.entry_hash).toBe(record.entry_hash);
  await unblockSync(page);
  await page.reload();
  await expect.poll(() => ledgerEntriesForDevice(local.settings.device_identity).length).toBe(1);
  expect(ledgerEntriesForDevice(local.settings.device_identity)[0].entry_hash).toBe(record.entry_hash);
});

test("Q2 a failed queue write saves neither the record nor the queue entry", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q2"));
  await blockSync(page);
  await confirmRecord(page, 3201);
  const before = await readLocalState(page);
  await prepareRecord(page, 3202);
  await setT3(page, { failQueueAdd: true });
  const dialogPromise = page.waitForEvent("dialog");
  await page.locator("#confirm-append").click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toMatch(/interrupted|Unable/i);
  await dialog.accept();
  await page.reload();
  const after = await readLocalState(page);
  expect(ownRecords(after)).toEqual(ownRecords(before));
  expect(after.stores.syncQueue).toEqual(before.stores.syncQueue);
});

test("Q3 a label-usage failure does not block or alarm; the record is saved, queued and synced", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("t3-q3"));
  await blockSync(page);
  let dialogSeen = "";
  page.on("dialog", async (dialog) => { dialogSeen = dialog.message(); await dialog.dismiss(); });
  await prepareRecord(page, 3301);
  await setT3(page, { failUsage: true });
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  expect(dialogSeen).toBe("");
  const local = await readLocalState(page);
  const [record] = ownRecords(local);
  expect(record).toBeTruthy();
  expect(local.stores.syncQueue.map((item) => item.entry_hash)).toEqual([record.entry_hash]);
  await unblockSync(page);
  await page.reload();
  await expect.poll(() => ledgerEntriesForDevice(account.local.settings.device_identity || local.settings.device_identity).length).toBe(1);
});

test("Q4 an unqueued device record is queued once on open, and never twice", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q4"));
  await blockSync(page);
  await confirmRecord(page, 3401);
  await clearStore(page, "syncQueue"); // the state an older version could leave
  const seeded = await readLocalState(page);
  const [record] = ownRecords(seeded);
  expect(seeded.stores.syncQueue).toEqual([]);

  await page.reload();
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(1);
  expect((await readLocalState(page)).stores.syncQueue[0].entry_hash).toBe(record.entry_hash);
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await page.waitForTimeout(500);
  expect((await readLocalState(page)).stores.syncQueue).toHaveLength(1);

  await unblockSync(page);
  await page.reload();
  await expect.poll(() => ledgerEntriesForDevice(seeded.settings.device_identity).length).toBe(1);
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(0);
  await page.reload();
  await page.waitForTimeout(500);
  expect((await readLocalState(page)).stores.syncQueue).toEqual([]);
});

test("Q4b two tabs repairing at once add exactly one queue entry", async ({ page, context }) => {
  await signInThroughUi(page, nextAccount("t3-q4b"));
  await context.route("**/sync/entries", (route) => route.abort("connectionrefused"));
  await confirmRecord(page, 3411);
  await clearStore(page, "syncQueue");
  const pageB = await context.newPage();
  await installIdbFault(pageB);
  await installT3Faults(pageB);
  await Promise.all([page.reload(), pageB.goto("/")]);
  await expect(pageB.locator("#screen-capture.active")).toBeVisible();
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(1);
  await page.waitForTimeout(500);
  expect((await readLocalState(page)).stores.syncQueue).toHaveLength(1);
});

test("Q4c a record acknowledged between repair's scan and its transaction is not queued", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q4c"));
  await blockSync(page);
  await confirmRecord(page, 3421);
  await clearStore(page, "syncQueue");
  const [record] = ownRecords(await readLocalState(page));
  await page.evaluate((id) => sessionStorage.setItem("__t3AttestBeforeRepair", String(id)), record.id);
  await page.addInitScript(() => {
    const id = Number(sessionStorage.getItem("__t3AttestBeforeRepair") || 0);
    if (id) {
      sessionStorage.removeItem("__t3AttestBeforeRepair");
      window.__t3.attestBeforeRepairId = id;
    }
  });
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect.poll(async () => ownRecords(await readLocalState(page))[0]?.evidence_level).toBe("server_attested");
  await page.waitForTimeout(500);
  expect((await readLocalState(page)).stores.syncQueue).toEqual([]);
});

test("Q4d an unqueued older record with a queued newer one syncs in chain order", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q4d"));
  await blockSync(page);
  await confirmRecord(page, 3431);
  await confirmRecord(page, 3432);
  const local = await readLocalState(page);
  const [older, newer] = ownRecords(local);
  expect(newer.prev_entry_hash).toBe(older.entry_hash);
  await deleteQueueEntryFor(page, older.entry_hash); // N unqueued, N+1 still queued
  expect((await readLocalState(page)).stores.syncQueue.map((item) => item.entry_hash)).toEqual([newer.entry_hash]);
  await unblockSync(page);
  await page.reload();
  await expect.poll(() => ledgerEntriesForDevice(local.settings.device_identity).map((entry) => entry.entry_hash))
    .toEqual([older.entry_hash, newer.entry_hash]);
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(0);
});

for (const legacy of ["descendant", "ancestor"]) {
  test(`Q4f an older-format queue item without entry_id (${legacy}) still syncs in chain order`, async ({ page }) => {
    await signInThroughUi(page, nextAccount(`t3-q4f-${legacy}`));
    await blockSync(page);
    await confirmRecord(page, 3451);
    await confirmRecord(page, 3452);
    const local = await readLocalState(page);
    const [older, newer] = ownRecords(local);
    // One record keeps an older-shape queue item (no top-level entry_id); the
    // other loses its queue item and is re-added by the repair.
    const keptLegacy = legacy === "descendant" ? newer : older;
    const missing = legacy === "descendant" ? older : newer;
    await deleteQueueEntryFor(page, missing.entry_hash);
    await page.evaluate(async (hash) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("confirma-v3-db", 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("syncQueue", "readwrite");
        const store = tx.objectStore("syncQueue");
        const all = store.getAll();
        all.onsuccess = () => all.result.filter((item) => item.entry_hash === hash).forEach((item) => {
          delete item.entry_id;
          store.put(item);
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, keptLegacy.entry_hash);
    expect((await readLocalState(page)).stores.syncQueue[0].entry_id).toBeUndefined();
    await unblockSync(page);
    await page.reload();
    await expect.poll(() => ledgerEntriesForDevice(local.settings.device_identity).map((entry) => entry.entry_hash))
      .toEqual([older.entry_hash, newer.entry_hash]);
  });
}

test("Q4e a restored (imported) record is never queued by the repair", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q4e"));
  await blockSync(page);
  await confirmRecord(page, 3441);
  const local = await readLocalState(page);
  const [own] = ownRecords(local);
  await clearStore(page, "syncQueue");
  await page.evaluate(async (record) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("confirma-v3-db", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { ...own, id: 1000000001, entry_hash: "f".repeat(64), importedFromServer: true });
  await page.reload();
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(1);
  await page.waitForTimeout(500);
  const after = await readLocalState(page);
  expect(after.stores.syncQueue.map((item) => item.entry_hash)).toEqual([own.entry_hash]);
});

test("Q5 records on a locked legacy install are not queued before consent and sign-in", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q5"));
  await blockSync(page);
  await confirmRecord(page, 3501);
  await clearStore(page, "syncQueue");
  await writeLocalState(page, { auth_token: preSliceAToken(), bound_account: "", signed_out: false });
  await page.reload();
  await expect(page.locator("#signed-out-copy")).toHaveText("Verify your email to open the records on this device.");
  await page.waitForTimeout(500);
  const local = await readLocalState(page);
  expect(ownRecords(local)).toHaveLength(1);
  expect(local.stores.syncQueue).toEqual([]);
});

test("Q6 repair writes nothing while signed out", async ({ page }) => {
  await signInThroughUi(page, nextAccount("t3-q6"));
  await blockSync(page);
  await confirmRecord(page, 3601);
  await clearStore(page, "syncQueue");
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  await page.waitForTimeout(500);
  const local = await readLocalState(page);
  expect(ownRecords(local)).toHaveLength(1);
  expect(local.stores.syncQueue).toEqual([]);
});

for (const [name, key, value] of [
  ["Q6b a sign-out committed between repair's scan and its write queues nothing", "signed_out", true],
  ["Q6c a pending data removal between repair's scan and its write queues nothing", "wipe_pending", true]
]) {
  test(name, async ({ page }) => {
    await signInThroughUi(page, nextAccount(`t3-${key}`));
    await blockSync(page);
    await confirmRecord(page, 3621);
    await clearStore(page, "syncQueue");
    await armBeforeNextLoad(page, "__t3SettingBeforeRepair", { key, value });
    await page.reload();
    await expect.poll(async () => (await readLocalState(page)).settings[key]).toBe(true);
    await page.waitForTimeout(500);
    const local = await readLocalState(page);
    expect(ownRecords(local)).toHaveLength(1);
    expect(local.stores.syncQueue).toEqual([]);
  });
}

async function expectContiguousPair(page, deviceIdentity) {
  const local = await readLocalState(page);
  const records = ownRecords(local);
  expect(records).toHaveLength(2);
  expect(records[1].id).toBe(records[0].id + 1);
  expect(records[1].prev_entry_hash).toBe(records[0].entry_hash);
  return { local, records, deviceIdentity };
}

test("Q7 two tabs confirming at once both save one contiguous chain (Web Locks)", async ({ page, context }) => {
  await signInThroughUi(page, nextAccount("t3-q7"));
  await context.route("**/sync/entries", (route) => route.abort("connectionrefused"));
  const pageB = await openSecondPage(context);
  expect(await page.evaluate(() => Boolean(navigator.locks?.request))).toBe(true);
  await prepareRecord(page, 3701);
  await prepareRecord(pageB, 3702);
  await setT3(page, { holdSign: true });
  await page.locator("#confirm-append").click();
  await expect.poll(() => page.evaluate(() => window.__t3.signHeld)).toBe(true);
  await pageB.locator("#confirm-append").click();
  await page.evaluate(() => window.__t3.release());
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  await expect(pageB.locator("#screen-dashboard.active")).toBeVisible();
  const { local, records } = await expectContiguousPair(page);
  expect(local.stores.syncQueue.map((item) => item.entry_hash).sort()).toEqual(records.map((r) => r.entry_hash).sort());
  await context.unroute("**/sync/entries");
  await page.reload();
  await expect.poll(() => ledgerEntriesForDevice(local.settings.device_identity).length).toBe(2);
});

test("Q7b without Web Locks, a stale head is rechecked, re-signed, and both records survive", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const page = await context.newPage();
  await installIdbFault(page);
  await installT3Faults(page, { removeLocks: true });
  try {
    await signInThroughUi(page, nextAccount("t3-q7b"));
    await context.route("**/sync/entries", (route) => route.abort("connectionrefused"));
    const pageB = await openSecondPage(context, { removeLocks: true });
    expect(await page.evaluate(() => Boolean(navigator.locks))).toBe(false);
    expect(await pageB.evaluate(() => Boolean(navigator.locks))).toBe(false);
    await prepareRecord(page, 3711);
    await prepareRecord(pageB, 3712);
    await setT3(page, { holdSign: true });
    await setT3(pageB, { holdSign: true });
    await page.locator("#confirm-append").click();
    await pageB.locator("#confirm-append").click();
    await expect.poll(() => page.evaluate(() => window.__t3.signHeld)).toBe(true);
    await expect.poll(() => pageB.evaluate(() => window.__t3.signHeld)).toBe(true);
    const signsBefore = await pageB.evaluate(() => window.__t3.signCount);
    await page.evaluate(() => window.__t3.release());
    await expect(page.locator("#screen-dashboard.active")).toBeVisible();
    await pageB.evaluate(() => window.__t3.release());
    await expect(pageB.locator("#screen-dashboard.active")).toBeVisible();
    expect(await pageB.evaluate(() => window.__t3.signCount)).toBeGreaterThan(signsBefore);
    const { local, records } = await expectContiguousPair(page);
    expect(local.stores.syncQueue.map((item) => item.entry_hash).sort()).toEqual(records.map((r) => r.entry_hash).sort());
    await context.unroute("**/sync/entries");
    await page.reload();
    await expect.poll(() => ledgerEntriesForDevice(local.settings.device_identity).length).toBe(2);
  } finally {
    await context.close();
  }
});

test("Q8a sign-out during a held confirm blocks the late record and keeps existing records", async ({ page, context }) => {
  await signInThroughUi(page, nextAccount("t3-q8a"));
  await context.route("**/sync/entries", (route) => route.abort("connectionrefused"));
  await confirmRecord(page, 3801);
  const before = await readLocalState(page);
  const pageB = await openSecondPage(context);
  await prepareRecord(pageB, 3802);
  await setT3(pageB, { holdSign: true });
  await pageB.locator("#confirm-append").click();
  await expect.poll(() => pageB.evaluate(() => window.__t3.signHeld)).toBe(true);

  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();

  const dialogPromise = pageB.waitForEvent("dialog");
  await pageB.evaluate(() => window.__t3.release());
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("record wasn't saved");
  await dialog.accept();
  const after = await readLocalState(page);
  expect(ownRecords(after)).toEqual(ownRecords(before));
  expect(after.stores.syncQueue).toEqual(before.stores.syncQueue);
});

// Q8b (removal during a held confirm clears everything and blocks the late
// append) is covered by signout.spec.mjs "F6 a held confirmation in a second
// tab cannot recreate data after wipe", which now exercises the combined
// record+queue transaction.
