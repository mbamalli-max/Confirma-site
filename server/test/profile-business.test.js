import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
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
    `SELECT p.business_type_id, p.sector_id, p.preferred_labels, p.business_description, p.classification_review
       FROM profiles p INNER JOIN users u ON u.id = p.user_id WHERE u.phone_number = $1`,
    [profile.phone]
  );
  return result.rows[0];
}

before(async () => {
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

test("S3: the server sets the sector from the catalog and clears labels for unlisted", async () => {
  const account = await signIn();
  let response = await saveProfile(account, {
    business_type_id: "ng_market_trader",
    sector_id: "digital_online",
    preferred_labels: ["Rice", "Beans"]
  });
  assert.equal(response.statusCode, 200, response.body);
  let row = await storedRow(account);
  assert.equal(row.sector_id, "trade_retail", "the phone's mismatched sector is replaced");
  assert.deepEqual(row.preferred_labels, ["Rice", "Beans"]);

  response = await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Document courier and errands",
    sector_id: "trade_retail",
    preferred_labels: ["Rice"]
  });
  assert.equal(response.statusCode, 200, response.body);
  row = await storedRow(account);
  assert.equal(row.business_type_id, "unlisted");
  assert.equal(row.sector_id, null);
  assert.deepEqual(row.preferred_labels, []);

  for (const fields of [
    { business_type_id: "ng_pos_agent" },
    { business_type_id: "__proto__" },
    { business_type_id: "constructor" },
    { business_type_id: "", sector_id: "not_a_sector" }
  ]) {
    response = await saveProfile(account, fields);
    assert.equal(response.statusCode, 400, `${JSON.stringify(fields)}: ${response.body}`);
  }
  assert.equal((await storedRow(account)).business_type_id, "unlisted", "rejected saves change nothing");

  response = await saveProfile(account, { business_type_id: "", sector_id: "food_hospitality" });
  assert.equal(response.statusCode, 200, "a legacy sector-only profile still saves");
  row = await storedRow(account);
  assert.equal(row.business_type_id, null);
  assert.equal(row.sector_id, "food_hospitality");
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

test("S6: GET /profile returns the description", async () => {
  const account = await signIn();
  assert.equal((await saveProfile(account, {
    business_type_id: "unlisted",
    business_description: "Document courier and errands"
  })).statusCode, 200);
  const profile = await storedProfile(account);
  assert.equal(profile.business_type_id, "unlisted");
  assert.equal(profile.business_description, "Document courier and errands");
  assert.equal(profile.sector_id, "");
  assert.deepEqual(profile.preferred_labels, []);
});

test("S7: the server catalog map matches the app catalog exactly", () => {
  const appMap = Object.fromEntries(BUSINESS_TYPES.map((item) => [item.id, { sector_id: item.sector_id, country: item.country }]));
  assert.deepEqual({ ...BUSINESS_TYPE_CATALOG }, appMap);
  assert.deepEqual([...SECTOR_IDS], SECTORS.map((item) => item.id));
  assert.equal(Object.hasOwn(BUSINESS_TYPE_CATALOG, "unlisted"), false, "unlisted is not a catalog type");
});
