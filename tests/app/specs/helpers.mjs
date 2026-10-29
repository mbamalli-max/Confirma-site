import { createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { assertLocalDatabaseUrl, databaseCommandTarget } from "../scripts/local-only.mjs";

export const APP_API_URL = (process.env.APP_TEST_API_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

let accountSequence = 0;
const accountRunId = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
const otpRateFile = fileURLToPath(new URL("../test-results/otp-rate-limit.json", import.meta.url));

export function nextAccount(label = "account") {
  accountSequence += 1;
  const suffix = `${accountRunId}-${accountSequence}`;
  const phoneTail = String((Date.now() + Number.parseInt(randomBytes(3).toString("hex"), 16) + accountSequence) % 10_000_000).padStart(7, "0");
  return {
    email: `${label}.${suffix}@example.test`,
    phone: `0803${phoneTail}`,
    name: `${label} business`
  };
}

const OTP_WINDOW_MS = 65_000;

async function paceOtp(kind, limit) {
  const startedAt = Date.now();
  while (true) {
    let state = { request: [], verify: [], totals: { request: 0, verify: 0 } };
    try {
      state = JSON.parse(await readFile(otpRateFile, "utf8"));
    } catch {
      // Global setup normally creates the file; retaining this fallback keeps
      // a directly-invoked worker deterministic.
    }
    const now = Date.now();
    const recent = (Array.isArray(state[kind]) ? state[kind] : []).filter((time) => now - time < OTP_WINDOW_MS);
    if (recent.length < limit) {
      state[kind] = [...recent, now];
      state.totals = state.totals && typeof state.totals === "object" ? state.totals : { request: 0, verify: 0 };
      state.totals[kind] = Number(state.totals[kind] || 0) + 1;
      const temporary = `${otpRateFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await rename(temporary, otpRateFile);
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, OTP_WINDOW_MS + 50 - (now - recent[0]))));
  }
}

async function otpRequestDiagnostics(page, pacingMs) {
  return page.evaluate(async ({ pacingMs }) => {
    const phoneAnchorRow = [...document.querySelectorAll("#otp-status-card .settings-row")]
      .find((row) => row.querySelector("span")?.textContent?.trim() === "Phone anchor");
    const phoneAnchor = phoneAnchorRow?.querySelector("strong")?.textContent?.trim() || "not displayed";
    const profileSummaryPopulated = Boolean(document.querySelector("#profile-summary")?.textContent?.trim());

    let storedProfileHasPhoneNumber = null;
    try {
      const request = indexedDB.open("confirma-v3-db", 5);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const storedProfile = await new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", "readonly");
        const get = transaction.objectStore("settings").get("profile");
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => reject(get.error);
      });
      db.close();
      storedProfileHasPhoneNumber = Boolean(String(storedProfile?.phone_number || "").trim());
    } catch {
      // A diagnostic must not hide the original request failure.
    }

    return [
      `phone_anchor=${phoneAnchor}`,
      `stored_profile_phone_number=${storedProfileHasPhoneNumber == null ? "unavailable" : (storedProfileHasPhoneNumber ? "present" : "missing")}`,
      `profile_summary=${profileSummaryPopulated ? "populated" : "empty"}`,
      `pacing_ms=${pacingMs}`
    ].join("; ");
  }, { pacingMs });
}

export async function installIdbFault(page) {
  // This belongs to the browser test process, not to the app.  It lets a
  // test abort precisely one transaction after its writes have been queued.
  await page.addInitScript(() => {
    window.__signoutTestFault = { next: "", fired: null, recordWriteHeld: false };
    const original = IDBDatabase.prototype.transaction;
    const originalPut = IDBObjectStore.prototype.put;
    const originalDelete = IDBObjectStore.prototype.delete;
    const transactionKeys = new WeakMap();
    const transactionStoreNames = new WeakMap();
    const rememberKey = (store, key) => {
      const keys = transactionKeys.get(store.transaction) || [];
      keys.push(String(key));
      transactionKeys.set(store.transaction, keys);
    };
    const abortForNamedSetting = (store, key) => {
      const fault = window.__signoutTestFault?.next;
      if (store.name !== "settings" || fault?.settingKey !== key) return;
      window.__signoutTestFault.next = "";
      window.__signoutTestFault.fired = {
        settingKey: key,
        storeNames: transactionStoreNames.get(store.transaction) || [...store.transaction.objectStoreNames],
        keys: [...(transactionKeys.get(store.transaction) || [])]
      };
      queueMicrotask(() => store.transaction.abort());
    };
    const abortAfterWipeDeletes = (store, key) => {
      const fault = window.__signoutTestFault?.next;
      const storeNames = transactionStoreNames.get(store.transaction) || [...store.transaction.objectStoreNames];
      const wipeStores = ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log", "settings"];
      if (fault !== "wipe-after-deletes" || store.name !== "settings" || key !== "wipe_epoch"
        || storeNames.length !== wipeStores.length || !wipeStores.every((name, index) => storeNames[index] === name)) return;
      window.__signoutTestFault.next = "";
      window.__signoutTestFault.fired = {
        settingKey: key,
        storeNames,
        keys: [...(transactionKeys.get(store.transaction) || [])]
      };
      queueMicrotask(() => store.transaction.abort());
    };
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      const result = originalPut.call(this, value, key);
      rememberKey(this, value?.key ?? key);
      abortForNamedSetting(this, value?.key ?? key);
      abortAfterWipeDeletes(this, value?.key ?? key);
      if (window.__signoutTestFault?.next === "binding"
        && this.name === "settings"
        && value?.key === "auth_token"
        && value?.value) {
        window.__signoutTestFault.next = "";
        queueMicrotask(() => this.transaction.abort());
      }
      return result;
    };
    IDBObjectStore.prototype.delete = function patchedDelete(key) {
      const result = originalDelete.call(this, key);
      rememberKey(this, key);
      abortForNamedSetting(this, key);
      return result;
    };
    IDBDatabase.prototype.transaction = function patchedTransaction(storeNames, mode, options) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      if (mode === "readwrite" && names.includes("records")
        && localStorage.getItem("__signoutRestoreWriteRace") === "armed") {
        localStorage.removeItem("__signoutRestoreWriteRace");
        document.getElementById("settings-logout-v2")?.click();
      }
      const transaction = original.call(this, storeNames, mode, options);
      transactionStoreNames.set(transaction, names);
      const fault = window.__signoutTestFault?.next;
      const isSettingsOnly = names.length === 1 && names[0] === "settings";
      const isWipe = ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log", "settings"]
        .every((name) => names.includes(name));
      if (mode === "readwrite" && ((fault === "settings" && isSettingsOnly) || (fault === "wipe" && isWipe))) {
        window.__signoutTestFault.next = "";
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    };

    const originalSign = SubtleCrypto.prototype.sign;
    SubtleCrypto.prototype.sign = async function patchedSign(...args) {
      if (localStorage.getItem("__signoutRecordWriteHold") === "armed") {
        localStorage.removeItem("__signoutRecordWriteHold");
        window.__signoutTestFault.recordWriteHeld = true;
        await new Promise((resolve) => { window.__releaseSignoutRecordWrite = resolve; });
      }
      return originalSign.apply(this, args);
    };
  });
}

export async function armFault(page, kind) {
  await page.evaluate((next) => {
    window.__signoutTestFault.next = next;
    window.__signoutTestFault.fired = null;
  }, kind);
}

export async function armRestoreWriteRace(page) {
  await page.evaluate(() => localStorage.setItem("__signoutRestoreWriteRace", "armed"));
}

export async function armRecordWriteHold(page) {
  await page.evaluate(() => localStorage.setItem("__signoutRecordWriteHold", "armed"));
}

export async function releaseRecordWrite(page) {
  await page.evaluate(() => window.__releaseSignoutRecordWrite?.());
}

export async function readLocalState(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = [...db.objectStoreNames];
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readonly");
      const output = {};
      let remaining = stores.length;
      for (const name of stores) {
        const getAll = tx.objectStore(name).getAll();
        getAll.onsuccess = () => {
          output[name] = getAll.result;
          remaining -= 1;
          if (!remaining) resolve(output);
        };
      }
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const settings = Object.fromEntries((result.settings || []).map(({ key, value }) => [key, value]));
    return { settings, stores: result };
  });
}

export async function readStoredProfile(page) {
  const { stores } = await readLocalState(page);
  return (stores.settings || []).find((record) => record.key === "profile");
}

export async function writeLocalState(page, entries) {
  await page.evaluate(async (values) => {
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      const store = tx.objectStore("settings");
      Object.entries(values).forEach(([key, value]) => store.put({ key, value }));
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("state write aborted"));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, entries);
}

export async function deleteLocalSettings(page, keys) {
  await page.evaluate(async (settingKeys) => {
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      settingKeys.forEach((key) => tx.objectStore("settings").delete(key));
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("settings delete aborted"));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, keys);
}

export async function putStoreValue(page, storeName, value) {
  await page.evaluate(async ({ storeName, value }) => {
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { storeName, value });
}

export async function clearStore(page, storeName) {
  await page.evaluate(async (name) => {
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).clear();
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("store clear aborted"));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, storeName);
}

export function tokenSessionId(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sid || "";
}

export function preSliceAToken(phoneNumber = "+2348031234567") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ phone_number: phoneNumber, exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = createHmac("sha256", "local-app-playwright-secret").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function databaseCommand(sql) {
  const database = assertLocalDatabaseUrl(process.env.APP_TEST_DATABASE_URL);
  const target = databaseCommandTarget(database);
  const result = spawnSync("psql", [
    ...target.args,
    "--dbname", target.databaseName,
    "--no-align", "--tuples-only", "--quiet", "--set", "ON_ERROR_STOP=1",
    "--command", sql
  ], {
    encoding: "utf8",
    env: { ...process.env, ...target.env }
  });
  if (result.status !== 0) throw new Error(`read-only database assertion failed: ${result.stderr || "psql exited unsuccessfully"}`);
  return result.stdout.trim();
}

// Intentionally read-only.  Tests change server state through the same HTTP
// endpoints a device uses; this helper only observes the throwaway database.
export function sessionState(tokenOrSessionId) {
  const id = String(tokenOrSessionId).includes(".") ? tokenSessionId(tokenOrSessionId) : String(tokenOrSessionId);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("expected a UUID session id");
  const json = databaseCommand(`SELECT row_to_json(session) FROM (SELECT id::text, user_id::text, device_identity, revoked_at IS NULL AS active FROM user_sessions WHERE id = '${id}') session;`);
  return json ? JSON.parse(json) : null;
}

// Read-only: the synced ledger rows for one device, as the server's statement code receives them.
export function ledgerEntriesForDevice(deviceIdentity) {
  const id = String(deviceIdentity || "");
  if (!/^[0-9a-f]{16,128}$/i.test(id)) throw new Error("expected a hex device identity");
  const json = databaseCommand(`SELECT coalesce(json_agg(row_to_json(entry)), '[]'::json) FROM (SELECT entry_hash, confirmed_at, payload FROM ledger_entries WHERE device_identity = '${id}' ORDER BY entry_id) entry;`);
  return JSON.parse(json || "[]");
}

// Test fixture write (throwaway test database only): give a test account's unlisted profile a sector
// as a newer app version would store it, so an older app's behaviour can be checked against it.
export function setProfileSectorForEmail(email, sectorId, source) {
  const normalized = String(email || "").toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(normalized)) throw new Error("expected a test email address");
  if (!/^[a-z_]+$/.test(sectorId) || !/^[a-z_]+$/.test(source)) throw new Error("expected plain sector and source ids");
  databaseCommand(`UPDATE profiles p SET sector_id = '${sectorId}', sector_source = '${source}' FROM users u WHERE u.id = p.user_id AND lower(u.email) = '${normalized}';`);
}

// Read-only: the server profile row for a test account, found by its email.
export function profileRowForEmail(email) {
  const normalized = String(email || "").toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(normalized)) throw new Error("expected a test email address");
  const json = databaseCommand(`SELECT row_to_json(profile) FROM (SELECT p.business_type_id, p.sector_id, p.sector_source, p.preferred_labels, p.business_description, p.classification_review FROM profiles p INNER JOIN users u ON u.id = p.user_id WHERE lower(u.email) = '${normalized}') profile;`);
  return json ? JSON.parse(json) : null;
}

// Restore an existing account on a fresh device through the "Restore your account" link.
export async function restoreThroughUi(page, account) {
  await page.locator("#restore-account-link").click();
  await page.locator("#restore-email-input").fill(account.email);
  await paceOtp("request", 4);
  await page.locator("#restore-send-code").click();
  await expect(page.locator("#restore-helper-text")).toContainText("Development code:", { timeout: 70_000 });
  const code = (await page.locator("#restore-helper-text").textContent())?.match(/Development code:\s*(\d{6})/)?.[1];
  if (!code) throw new Error("local API did not expose its development restore code");
  await paceOtp("verify", 8);
  await page.locator("#restore-code-input").fill(code);
  await page.locator("#restore-verify-code").click();
}

export function accountSessionCount(accountId) {
  const id = String(accountId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("expected a UUID account id");
  return Number(databaseCommand(`SELECT count(*) FROM user_sessions WHERE user_id = '${id}';`) || 0);
}

export function userSessionCount(email) {
  const normalized = String(email || "").toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(normalized)) throw new Error("expected a test email address");
  return Number(databaseCommand(`SELECT count(*) FROM user_sessions AS s INNER JOIN users AS u ON u.id = s.user_id WHERE lower(u.email) = '${normalized}';`) || 0);
}

export async function revokeOnServer(page, token) {
  const response = await page.request.post(`${APP_API_URL}/auth/logout`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect([204, 401]).toContain(response.status());
}

export async function completeOnboarding(page, account, { navigate = true, clockInstalled = false } = {}) {
  const expectOnboardingStep = async (step, heading) => {
    await expect(page.locator("#onboarding-step-copy"), `expected onboarding step ${step} before continuing`).toHaveText(`Step ${step} of 6`, { timeout: 5_000 });
    await expect(page.getByRole("heading", { name: heading }), `expected onboarding heading for step ${step}`).toBeVisible({ timeout: 5_000 });
  };
  const fillProfileField = async (id, value) => {
    const field = page.locator(`#${id}`);
    await field.fill(value);
    const received = await field.inputValue();
    if (received === value) return;

    const values = await Promise.all(["onboarding-name", "onboarding-phone", "onboarding-email"].map(async (fieldId) => {
      const fieldValue = await page.locator(`#${fieldId}`).inputValue();
      return fieldId === "onboarding-phone"
        ? `${fieldId}=${fieldValue ? "present" : "empty"} (length ${fieldValue.length})`
        : `${fieldId}=${JSON.stringify(fieldValue)}`;
    }));
    throw new Error(`onboarding ${id} received ${JSON.stringify(received)} instead of ${JSON.stringify(value)}; ${values.join("; ")}`);
  };

  if (navigate) await page.goto("/");
  await expectOnboardingStep(1, "Choose your phone country");
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await expectOnboardingStep(2, "Where does your business primarily operate?");
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await expectOnboardingStep(3, "What business do you do?");
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await expectOnboardingStep(4, "Choose your business type");
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await expectOnboardingStep(5, "Pick your common transactions");
  await page.locator("#onboarding-next").click();
  await expectOnboardingStep(6, "About you");
  // Step entry deliberately focuses the first field in rAF. Wait for that
  // callback before filling so test input cannot race the app's autofocus.
  // Playwright's fake clock does not advance animation frames on its own.
  if (clockInstalled) await page.clock.runFor(100);
  await expect(page.locator("#onboarding-name")).toBeFocused();
  await fillProfileField("onboarding-name", account.name);
  await fillProfileField("onboarding-phone", account.phone);
  await fillProfileField("onboarding-email", account.email);
  await expect(page.locator("#finish-onboarding")).toBeEnabled();
  // Exercise the same late render that used to replace already-edited fields
  // from the still-empty in-memory profile after returning to an earlier step.
  await expectOnboardingStep(6, "About you");
  await page.locator("#onboarding-back").click();
  await expectOnboardingStep(5, "Pick your common transactions");
  await page.locator("#onboarding-back").click();
  await expectOnboardingStep(4, "Choose your business type");
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await expectOnboardingStep(5, "Pick your common transactions");
  await page.locator("#onboarding-next").click();
  await expectOnboardingStep(6, "About you");
  await expect(page.locator("#onboarding-name")).toHaveValue(account.name);
  await expect(page.locator("#onboarding-phone")).toHaveValue(account.phone);
  await expect(page.locator("#onboarding-email")).toHaveValue(account.email);
  await expectOnboardingStep(6, "About you");
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  const storedProfile = await readStoredProfile(page);
  if (Boolean(String(storedProfile?.phone_number || "").trim()) !== Boolean(String(account.phone || "").trim())) {
    throw new Error("onboarding lost the phone number");
  }
}

export async function openVerification(page, account) {
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  const trustButton = page.locator("#settings-open-trust-v3");
  await expect(trustButton, "Verification is unavailable while the current account session is valid.")
    .toBeEnabled({ timeout: 2_000 });
  await trustButton.click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await page.locator("#otp-email-input").fill(account.email);
}

export async function requestCode(page) {
  let response;
  let pacingMs = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Stay below the server's rolling limit even when several UI paths request
    // codes in one test. The shared file counts every real request attempt.
    pacingMs += await paceOtp("request", 4);
    const button = page.locator("#otp-request-code");
    const email = (await page.locator("#otp-email-input").inputValue()).trim();
    if (!(await button.isEnabled())) {
      const label = (await button.textContent())?.trim() || "Send code";
      const diagnostics = await otpRequestDiagnostics(page, pacingMs);
      throw new Error(`OTP request was not sent: ${label} is disabled by the client (email ${email ? "is filled" : "is empty"}); ${diagnostics}.`);
    }
    const isOtpRequest = (candidate) => candidate.url().includes("/auth/otp/request")
      && candidate.method() === "POST";
    const requestPromise = page.waitForRequest(isOtpRequest, { timeout: 5_000 })
      .then((request) => ({ request }), (error) => ({ requestError: error }));
    const responsePromise = page.waitForResponse(
      (candidate) => isOtpRequest(candidate.request()),
      { timeout: 70_000 }
    ).then((candidate) => ({ response: candidate }), (error) => ({ responseError: error }));
    const fallbackPromise = page.getByText("Local development code for this device", { exact: false })
      .waitFor({ state: "visible", timeout: 70_000 })
      .then(() => ({ fallback: true }), () => null);
    await button.click();
    const dispatch = await requestPromise;
    if (!dispatch?.request) {
      const errorText = (await page.locator("#otp-error-text").textContent())?.trim();
      const helperText = (await page.locator("#otp-helper-text").textContent())?.trim();
      const activeScreen = await page.locator(".screen.active").getAttribute("id");
      const diagnostics = await otpRequestDiagnostics(page, pacingMs);
      throw new Error(
        `OTP request was not sent within 5 seconds after clicking Send code: screen=${activeScreen || "unknown"}; `
        + `email=${email ? "filled" : "empty"}; client_message=${errorText || helperText || "none"}; ${diagnostics}.`
      );
    }
    const outcome = await Promise.race([responsePromise, fallbackPromise]);
    if (outcome?.fallback) {
      throw new Error("The app used its local OTP fallback; browser tests require the real local server code.");
    }
    if (!outcome?.response) throw outcome?.responseError || new Error("No server response arrived for the OTP request.");
    response = outcome.response;
    if (response.status() !== 429) break;
    if (attempt === 1) throw new Error("Server rejected the retried OTP request with 429 after the rolling-window wait.");
    console.warn("OTP request returned 429; waiting out the shared 65-second window and retrying once.");
  }
  await expect(page.locator("#otp-helper-text")).toContainText("Development code:");
  const text = await page.locator("#otp-helper-text").textContent();
  if (text?.includes("Local development code for this device")) {
    throw new Error("The app used its local OTP fallback; browser tests require the real local server code.");
  }
  const code = text?.match(/Development code:\s*(\d{6})/)?.[1];
  if (!code) throw new Error("local API did not expose its development OTP code");
  return code;
}

export async function verifyWithCode(page, code) {
  await paceOtp("verify", 8);
  const response = page.waitForResponse((candidate) => candidate.url().includes("/auth/otp/verify") && candidate.request().method() === "POST");
  await page.locator("#otp-code-input").fill(code);
  await page.locator("#otp-verify-code").click();
  return response;
}

export async function signInThroughUi(page, account, onboardingOptions) {
  await completeOnboarding(page, account, onboardingOptions);
  // The shipped development default is 8787. Persist the configured local API
  // before verification so APP_TEST_API_URL can safely use another local port.
  await writeLocalState(page, { sync_api_base_url: APP_API_URL });
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect.poll(async () => (await page.locator("#profile-summary").textContent())?.trim() || "", {
    message: "the reloaded app should hydrate its working profile before verification opens"
  }).not.toBe("");
  await openVerification(page, account);
  const code = await requestCode(page);
  const verifyResponse = await verifyWithCode(page, code);
  expect(verifyResponse.status()).toBe(200);
  const responseBody = await verifyResponse.json();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  const local = await readLocalState(page);
  expect(local.settings.auth_token).toBe(responseBody.auth_token);
  expect(local.settings.bound_account).toBe(responseBody.account_id);
  expect(local.settings.local_origin).toBeUndefined();
  return { ...account, responseBody, token: responseBody.auth_token, accountId: responseBody.account_id, local };
}

export async function openSignedOutVerification(page, account) {
  await page.locator("#signed-out-sign-in").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await page.locator("#otp-email-input").fill(account.email);
}

export async function removeLocalData(page, { anyway = false } = {}) {
  const panel = page.locator("#remove-local-data-panel");
  if (!(await panel.isVisible())) {
    await page.locator("#signed-out-remove-data, #settings-remove-local-data").first().click();
  }
  if (!anyway) await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator(anyway ? "#remove-local-data-anyway" : "#remove-local-data-confirm").click();
}
