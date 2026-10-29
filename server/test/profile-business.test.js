import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { BUSINESS_TYPE_CATALOG, SECTOR_IDS } from "../src/business-catalog.js";
import { registerAccountRoutes } from "../src/routes/account.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { assertLocalTestDatabase, createTestPool, resetTestDatabase } from "./helpers/db.js";
import { BUSINESS_TYPES, SECTORS } from "../../app-v3/catalog-data.js";

// This guard intentionally runs before a pool is created or any SQL is issued.
assertLocalTestDatabase(config.databaseUrl);

const appPool = getPool();
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const app = Fastify({ logger: false });

config.allowDevOtp = true;
config.resendApiKey = "";
config.jwtSecret = config.jwtSecret || "profile-business-test-secret";

let sequence = 0;
function unique(prefix) {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}`;
}

async function signIn() {
  const email = `${unique("profile")}@example.test`;
  const phone = `+234801${String(Date.now() % 10_000_000).padStart(7, "0")}`.slice(0, 14);
  const deviceIdentity = unique("device");
  const requested = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: { channel: "email", email, phone_number: phone }
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const verified = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: {
      channel: "email",
      email,
      phone_number: phone,
      code: requested.json().dev_code,
      device_identity: deviceIdentity,
      public_key: `public-key-${deviceIdentity}`
    }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const { auth_token: token } = verified.json();
  assert.ok(token, "sign-in returns a token");
  return { headers: { authorization: `Bearer ${token}`, "x-device-identity": deviceIdentity } };
}

const BASE = { name: "Ada", business_name: "Ada Prints", country: "NG", operating_region: "NG", language: "en" };

function saveProfile(account, fields) {
  return app.inject({ method: "POST", url: "/profile", headers: account.headers, payload: { ...BASE, ...fields } });
}

async function storedProfile(account) {
  const response = await app.inject({ method: "GET", url: "/profile", headers: account.headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().profile;
}

async function storedRow(account) {
  const profile = await storedProfile(account);
  const result = await database.query(
    `SELECT p.business_type_id, p.sector_id, p.sector_source, p.preferred_labels, p.business_description, p.classification_review
       FROM profiles p INNER JOIN users u ON u.id = p.user_id WHERE u.phone_number = $1`,
    [profile.phone]
  );
  return result.rows[0];
}

before(async () => {
  await database.query(await readFile(new URL("../migrations/017_sector_assignment.sql", import.meta.url), "utf8"));
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  config.smsProviderEnabled = false;
  await resetTestDatabase(database);
});

after(async () => {
  await app.close();
  await appPool.end();
  await database.end();
});

test("S1: unlisted needs a 3-60 character description, and the database enforces the limit", async () => {
  const account = await signIn();
  for (const [label, fields] of [
    ["missing on a new profile", { business_type_id: "unlisted" }],
    ["blank", { business_type_id: "unlisted", business_description: "   " }],
    ["too short", { business_type_id: "unlisted", business_description: "ab" }],
    ["too long", { business_type_id: "unlisted", business_description: "x".repeat(61) }],
    ["control characters only", { business_type_id: "unlisted", business_description: "\u0000\u0007\n\t" }]
  ]) {
    const response = await saveProfile(account, fields);
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
  }

  const saved = await saveProfile(account, { business_type_id: "unlisted", business_description: `  ${"é".repeat(60)}  ` });
  assert.equal(saved.statusCode, 200, "60 characters (multi-byte) is allowed");
  assert.equal((await storedRow(account)).business_description, "é".repeat(60));

  await assert.rejects(
    database.query(`UPDATE profiles SET business_description = $1 WHERE business_type_id = 'unlisted'`, ["x".repeat(61)]),
    (error) => error.constraint === "profiles_business_description_length"
  );
  await assert.rejects(
    database.query(`UPDATE profiles SET business_description = NULL WHERE business_type_id = 'unlisted'`),
    (error) => error.constraint === "profiles_unlisted_description_pairing"
  );
});

test("S2: a listed type sent with a description stores no description", async () => {
  const account = await signIn();
  const response = await saveProfile(account, {
    business_type_id: "global_document_services",
    business_description: "Photocopy and typing"
  });
  assert.equal(response.statusCode, 200, response.body);
  const row = await storedRow(account);
  assert.equal(row.business_type_id, "global_document_services");
  assert.equal(row.business_description, null);
  assert.equal((await storedProfile(account)).business_description, "");
});

test("S3: the server sets the sector from the catalog, keeps an unlisted business's chosen sector and clears its labels", async () => {
  const account = await signIn();
  let response = await saveProfile(account, {
    business_type_id: "ng_market_trader",
    sector_id: "digital_online",
    preferred_labels: ["Rice", "Beans"]
  });
  assert.equal(response.statusCode, 200, response.body);
  let row = await storedRow(account);
  assert.equal(row.sector_id, "trade_retail", "the phone's mismatched sector is replaced");
  assert.equal(row.sector_source, "catalog");
  assert.deepEqual(row.preferred_labels, ["Rice", "Beans"]);

  response = await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Document courier and errands",
    sector_id: "transport_logistics",
    sector_confirmed: true,
    preferred_labels: ["Rice"]
  });
  assert.equal(response.statusCode, 200, response.body);
  row = await storedRow(account);
  assert.equal(row.business_type_id, "unlisted");
  assert.equal(row.sector_id, "transport_logistics", "an unlisted business keeps the sector the person chose");
  assert.equal(row.sector_source, "user");
  assert.deepEqual(row.preferred_labels, []);

  for (const fields of [
    { business_type_id: "ng_pos_agent" },
    { business_type_id: "__proto__" },
    { business_type_id: "constructor" },
    { business_type_id: "", sector_id: "not_a_sector" },
    { business_type_id: "unlisted", business_description: "Courier", sector_id: "uncategorised" },
    { business_type_id: "unlisted", business_description: "Courier", sector_id: "__proto__" },
    { business_type_id: "unlisted", business_description: "Courier", sector_id: 7 }
  ]) {
    response = await saveProfile(account, fields);
    assert.equal(response.statusCode, 400, `${JSON.stringify(fields)}: ${response.body}`);
  }
  row = await storedRow(account);
  assert.equal(row.business_type_id, "unlisted", "rejected saves change nothing");
  assert.equal(row.sector_id, "transport_logistics");

  response = await saveProfile(account, { business_type_id: "", sector_id: "food_hospitality" });
  assert.equal(response.statusCode, 200, "a legacy sector-only profile still saves");
  row = await storedRow(account);
  assert.equal(row.business_type_id, null);
  assert.equal(row.sector_id, "food_hospitality");
  assert.equal(row.sector_source, "user");
  assert.equal(row.business_description, null);
});

test("S4: a review field sent by the phone is ignored, on first save and on later saves", async () => {
  const account = await signIn();
  const fields = {
    business_type_id: "unlisted",
    business_description: "Document courier and errands",
    classification_review: "approved",
    review_status: "approved"
  };
  let response = await saveProfile(account, fields);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storedRow(account)).classification_review, null, "first save (insert)");

  // A value set by future admin tooling must survive phone saves untouched.
  await database.query(`UPDATE profiles SET classification_review = 'needs_review' WHERE business_type_id = 'unlisted'`);
  response = await saveProfile(account, { ...fields, classification_review: "approved" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storedRow(account)).classification_review, "needs_review", "later save (update)");
  response = await saveProfile(account, { business_type_id: "global_tutoring", classification_review: null });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storedRow(account)).classification_review, "needs_review", "a null from the phone does not clear it");
  const profile = await storedProfile(account);
  assert.equal(Object.hasOwn(profile, "classification_review"), false, "never returned to the phone");
});

test("S5: an older app's save without the description keeps it; a listed type clears it", async () => {
  const account = await signIn();
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Document courier and errands"
  })).statusCode, 200);

  // v36 body shape: no business_description key at all.
  let response = await saveProfile(account, { business_type_id: "unlisted", business_name: "Renamed", preferred_labels: [] });
  assert.equal(response.statusCode, 200, response.body);
  let row = await storedRow(account);
  assert.equal(row.business_description, "Document courier and errands");
  assert.equal((await storedProfile(account)).business_name, "Renamed");

  response = await saveProfile(account, { business_type_id: "global_tutoring" });
  assert.equal(response.statusCode, 200, response.body);
  row = await storedRow(account);
  assert.equal(row.business_type_id, "global_tutoring");
  assert.equal(row.business_description, null);
});

test("S6: GET /profile returns the description, the assigned sector, its source and completeness", async () => {
  const account = await signIn();
  // An older app's first unlisted save sends no sector: "Other business" as a fallback.
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Document courier and errands",
    sector_id: null
  })).statusCode, 200);
  let profile = await storedProfile(account);
  assert.equal(profile.business_type_id, "unlisted");
  assert.equal(profile.business_description, "Document courier and errands");
  assert.equal(profile.sector_id, "other_activity");
  assert.equal(profile.sector_source, "fallback");
  assert.equal(profile.profile_complete, false);
  assert.deepEqual(profile.preferred_labels, []);

  assert.equal((await saveProfile(account, { business_type_id: "ng_kiosk_phone_business" })).statusCode, 200);
  profile = await storedProfile(account);
  assert.equal(profile.sector_id, "trade_retail", "rule K1");
  assert.equal(profile.sector_source, "catalog");
  assert.equal(profile.profile_complete, true);
});

test("S7 (T-S1): the server catalog matches the app catalog and every type has exactly one valid named sector", () => {
  const appMap = Object.fromEntries(BUSINESS_TYPES.map((item) => [
    item.id,
    { sector_id: item.sector_id, country: item.country, suggestion_group: item.suggestion_group }
  ]));
  assert.deepEqual({ ...BUSINESS_TYPE_CATALOG }, appMap);
  assert.deepEqual([...SECTOR_IDS], SECTORS.map((item) => item.id));
  assert.equal(new Set(SECTOR_IDS).size, SECTOR_IDS.length);
  assert.equal(Object.hasOwn(BUSINESS_TYPE_CATALOG, "unlisted"), false, "unlisted is not a catalog type");
  assert.equal(SECTOR_IDS.includes("uncategorised"), false, "U2: there is no 'not categorised' sector");
  assert.equal(BUSINESS_TYPES.length, 26);
  for (const item of BUSINESS_TYPES) {
    assert.equal(typeof item.sector_id, "string", item.id);
    assert.ok(SECTOR_IDS.includes(item.sector_id) && item.sector_id !== "other_activity", `${item.id} is in one named sector`);
  }
  // Rules K1/K2 (U1), and suggestions keep each type's pre-2026-10-28 grouping.
  assert.equal(BUSINESS_TYPE_CATALOG.ng_kiosk_phone_business.sector_id, "trade_retail");
  assert.equal(BUSINESS_TYPE_CATALOG.ng_fashion_tailor.sector_id, "skilled_construction");
  const movedFrom = { ng_kiosk_phone_business: "digital_online", ng_fashion_tailor: "personal_professional" };
  for (const item of BUSINESS_TYPES) {
    assert.equal(item.suggestion_group, movedFrom[item.id] || item.sector_id, `${item.id} suggestion group unchanged`);
  }
});

test("S8 (T-S6): an older app never erases a stored sector, description or business", async () => {
  const account = await signIn();
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Poultry and eggs",
    sector_id: "agriculture",
    sector_confirmed: true
  })).statusCode, 200);

  for (const [label, fields] of [
    ["v37 body: unlisted with sector null", { business_type_id: "unlisted", business_description: "Poultry and eggs", sector_id: null }],
    ["v36 body: no description key, no sector key", { business_type_id: "unlisted" }],
    ["blank sector", { business_type_id: "unlisted", sector_id: "  " }],
    ["no business details at all", { business_type_id: "", sector_id: null, name: "Renamed" }],
    ["business keys absent", { name: "Renamed again" }]
  ]) {
    const response = await saveProfile(account, fields);
    assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
    const row = await storedRow(account);
    assert.equal(row.business_type_id, "unlisted", label);
    assert.equal(row.business_description, "Poultry and eggs", label);
    assert.equal(row.sector_id, "agriculture", label);
    assert.equal(row.sector_source, "user", label);
  }
  assert.equal((await storedProfile(account)).name, "Renamed again");
});

test("S9: a fallback is never upgraded by an echo; a deliberate choice is the person's; a listed->unlisted switch is not carried over", async () => {
  const account = await signIn();
  assert.equal((await saveProfile(account, { business_type_id: "global_tutoring" })).statusCode, 200);
  // An older app switching to unlisted sends no sector: the tutoring sector is not carried over.
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted", business_description: "Fish farming", sector_id: null
  })).statusCode, 200);
  let row = await storedRow(account);
  assert.deepEqual([row.sector_id, row.sector_source], ["other_activity", "fallback"]);

  // The app echoing the stored sector back does not make it the person's choice.
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted", business_description: "Fish farming", sector_id: "other_activity"
  })).statusCode, 200);
  row = await storedRow(account);
  assert.deepEqual([row.sector_id, row.sector_source], ["other_activity", "fallback"]);
  assert.equal((await storedProfile(account)).profile_complete, false);

  // A deliberate "None of these fit" is the person's own Other.
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted", business_description: "Fish farming", sector_id: "other_activity", sector_confirmed: true
  })).statusCode, 200);
  row = await storedRow(account);
  assert.deepEqual([row.sector_id, row.sector_source], ["other_activity", "user"]);
  assert.equal((await storedProfile(account)).profile_complete, true);

  // A different sector is a deliberate change even without the flag.
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted", business_description: "Fish farming", sector_id: "agriculture"
  })).statusCode, 200);
  row = await storedRow(account);
  assert.deepEqual([row.sector_id, row.sector_source], ["agriculture", "user"]);
});

test("S10 (T-S8): corrections persist through save and reload, and completeness follows", async () => {
  const account = await signIn();
  const steps = [
    [{ business_type_id: "unlisted", business_description: "Tailoring and repairs", sector_id: "personal_professional", sector_confirmed: true }, "personal_professional", "user", true],
    [{ business_type_id: "ng_fashion_tailor" }, "skilled_construction", "catalog", true],
    [{ business_type_id: "unlisted", business_description: "Cattle trading", sector_id: "agriculture", sector_confirmed: true }, "agriculture", "user", true],
    [{ business_type_id: "", sector_id: "agriculture" }, "agriculture", "user", false]
  ];
  for (const [fields, sector, source, complete] of steps) {
    const response = await saveProfile(account, fields);
    assert.equal(response.statusCode, 200, response.body);
    const profile = await storedProfile(account);
    assert.deepEqual([profile.sector_id, profile.sector_source, profile.profile_complete], [sector, source, complete], JSON.stringify(fields));
    const again = await storedProfile(account);
    assert.deepEqual(again, profile, "a second read (restore) returns the same profile");
  }
});

test("S11 (T-S5, T-S7): a row without a business has no sector; the database refuses a business without one", async () => {
  const account = await signIn();
  const phone = (await storedProfile(account))?.phone;
  const user = (await database.query(`SELECT id, phone_number FROM users ORDER BY created_at DESC LIMIT 1`)).rows[0];
  // The free-report route creates phone-only rows like this one.
  await database.query(`INSERT INTO profiles (user_id, phone_number, updated_at) VALUES ($1, $2, NOW())`, [user.id, phone || user.phone_number]);
  let profile = await storedProfile(account);
  assert.deepEqual([profile.sector_id, profile.sector_source, profile.profile_complete], ["", null, false]);

  for (const [sql, constraint] of [
    [`UPDATE profiles SET business_type_id = 'global_tutoring' WHERE user_id = $1`, "profiles_business_has_sector"],
    [`UPDATE profiles SET sector_id = 'not_a_sector', sector_source = 'user' WHERE user_id = $1`, "profiles_sector_id_valid"],
    [`UPDATE profiles SET sector_id = 'agriculture' WHERE user_id = $1`, "profiles_sector_source_pairing"],
    [`UPDATE profiles SET sector_id = 'agriculture', sector_source = 'guess' WHERE user_id = $1`, "profiles_sector_source_valid"]
  ]) {
    await assert.rejects(database.query(sql, [user.id]), (error) => error.constraint === constraint, constraint);
  }

  // Saving a business turns it into a business profile with a sector.
  assert.equal((await saveProfile(account, { business_type_id: "global_tutoring" })).statusCode, 200);
  profile = await storedProfile(account);
  assert.deepEqual([profile.sector_id, profile.sector_source], ["personal_professional", "catalog"]);
});
