import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { hashOtp, issueAuthToken, normalizeInternationalPhoneNumber, phoneChangeCodeDigest, phoneDigits } from "../src/auth-utils.js";
import { registerAccountRoutes } from "../src/routes/account.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { assertLocalTestDatabase, createStageDatabase, createTestPool, instrumentApplicationPool, resetTestDatabase } from "./helpers/db.js";

// This suite deliberately uses a local database and injected mail delivery. It
// never loads Resend; sent codes/notices are captured only in this process.
assertLocalTestDatabase(config.databaseUrl);
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const poolRecorder = instrumentApplicationPool(getPool());
const codes = []; const notices = []; let app; let logLines;
function email() { return `m2-${crypto.randomUUID().slice(0, 8)}@example.test`; }
function headers(a) { return { authorization: `Bearer ${a.token}`, "x-device-identity": a.device }; }
async function account({ phone = `+234803${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`, address = email() } = {}) {
  const user = (await database.query("INSERT INTO users (phone_number,email,email_verified,phone_verified) VALUES ($1,$2,TRUE,TRUE) RETURNING id", [phone, address])).rows[0];
  const device = `m2-${crypto.randomUUID()}`; const sid = crypto.randomUUID();
  await database.query("INSERT INTO device_identities (device_identity,public_key,phone_number,user_id) VALUES ($1,'test-key',$2,$3)", [device, phone, user.id]);
  await database.query("INSERT INTO profiles (user_id,phone_number,name) VALUES ($1,$2,'M2 test')", [user.id, phone]);
  await database.query("INSERT INTO user_sessions (id,user_id,device_identity) VALUES ($1,$2,$3)", [sid, user.id, device]);
  return { ...user, phone, address, device, token: issueAuthToken(phone, device, { sid, account_id: user.id }) };
}
async function requestChange(a, target) {
  const response = await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(a), payload: { new_phone_number: target } });
  assert.equal(response.statusCode, 200, response.body); return codes.at(-1).code;
}
async function confirm(a, target, code) { return app.inject({ method: "POST", url: "/account/phone-change/confirm", headers: headers(a), payload: { new_phone_number: target, code } }); }
async function emailSignIn({ address, phone, device = `m2-email-${crypto.randomUUID()}` }) {
  const code = await requestEmailSignIn({ address, phone });
  const response = await verifyEmailSignIn({ address, phone, code, device });
  assert.equal(response.statusCode, 200, response.body);
  return response;
}
async function requestEmailSignIn({ address, phone }) {
  const requested = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { channel: "email", email: address, phone_number: phone } });
  assert.equal(requested.statusCode, 200, requested.body);
  return requested.json().dev_code;
}
function verifyEmailSignIn({ address, phone, code, device = `m2-email-${crypto.randomUUID()}` }) {
  return app.inject({ method: "POST", url: "/auth/otp/verify", payload: { channel: "email", email: address, phone_number: phone, code, device_identity: device, public_key: `key-${device}` } });
}
function noLeak(text, values) { for (const value of values) assert.equal(text.toLowerCase().includes(String(value).toLowerCase()), false, `leaked ${value}`); }

before(async () => {
  config.jwtSecret = "m2-phone-change-test-secret-not-production"; config.resendApiKey = ""; logLines = [];
  app = Fastify({ logger: { level: "error", stream: { write: (line) => logLines.push(line) } } });
  config.allowDevOtp = true;
  await registerAuthRoutes(app);
  await registerAccountRoutes(app, {
    sendPhoneChangeEmail: async (to, code) => { codes.push({ to, code }); },
    sendPhoneChangeNotice: async (to, changedAt) => { notices.push({ to, changedAt }); }
  });
  await app.ready();
});
beforeEach(async () => { await resetTestDatabase(database); poolRecorder.reset(); codes.length = 0; notices.length = 0; logLines.length = 0; });
after(async () => { await app.close(); await database.end(); poolRecorder.restore(); await getPool().end(); });

test("M2 phone input is international and stored canonically", () => {
  assert.equal(normalizeInternationalPhoneNumber("+234 803-123-4567"), "+2348031234567");
  assert.equal(normalizeInternationalPhoneNumber("2348031234567"), "");
  assert.equal(normalizeInternationalPhoneNumber("+08031234567"), "");
  assert.equal(phoneDigits("+234 803-123-4567"), "2348031234567");
});

test("phone-change request rejects a zero-prefixed international number without creating a challenge", async () => {
  const owner = await account({ phone: "+2348030000006" });
  const response = await app.inject({
    method: "POST",
    url: "/account/phone-change/request",
    headers: headers(owner),
    payload: { new_phone_number: "+08031234567" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Enter an international phone number with 7 to 15 digits.");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM phone_change_challenges WHERE user_id=$1", [owner.id])).rows[0].n, 0);
});

test("phone-change email delivery falls back to a development code only when enabled", async () => {
  const owner = await account({ phone: "+2348030000007" });
  const target = "+2348030000008";
  const deliveryFailure = async () => { throw new Error("mail unavailable"); };
  const development = Fastify();
  await registerAccountRoutes(development, { sendPhoneChangeEmail: deliveryFailure, sendPhoneChangeNotice: async () => {} });
  await development.ready();
  const original = config.allowDevOtp;
  try {
    config.allowDevOtp = true;
    const fallback = await development.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: target } });
    assert.equal(fallback.statusCode, 200);
    assert.equal(fallback.json().delivery, "development");
    assert.match(fallback.json().dev_code, /^\d{6}$/);
    assert.equal((await database.query("SELECT superseded_at IS NULL AS usable FROM phone_change_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [owner.id])).rows[0].usable, true);

    config.allowDevOtp = false;
    const unavailable = await development.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: "+2348030000009" } });
    assert.equal(unavailable.statusCode, 502);
    assert.equal(Object.hasOwn(unavailable.json(), "dev_code"), false);
  } finally {
    config.allowDevOtp = original;
    await development.close();
  }
});

test("024 real runner: one populated pair is tagged and a rerun is a no-op", async () => {
  const stage = await createStageDatabase(23, { databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl });
  try {
    const q = (...args) => stage.pool.query(...args);
    const x = (await q("INSERT INTO users (phone_number) VALUES ('+2348030000001') RETURNING id")).rows[0];
    const y = (await q("INSERT INTO users (phone_number) VALUES ('2348030000001') RETURNING id")).rows[0];
    const untouched = (await q("INSERT INTO users (phone_number) VALUES ('+2348030000002') RETURNING id")).rows[0];
    await stage.runMigrations(24);
    const tagged = (await q("SELECT id,phone_share_group FROM users WHERE id=ANY($1::uuid[]) ORDER BY id", [[x.id, y.id]])).rows;
    assert.ok(tagged[0].phone_share_group); assert.equal(tagged[0].phone_share_group, tagged[1].phone_share_group);
    assert.notEqual(tagged[0].phone_share_group, x.id); assert.notEqual(tagged[0].phone_share_group, y.id);
    assert.equal((await q("SELECT phone_share_group FROM users WHERE id=$1", [untouched.id])).rows[0].phone_share_group, null);
    assert.match((await stage.runMigrations(24)).stdout, /No pending migrations/);
  } finally { await stage.drop(); }
});

test("024 rejects multiple collision groups and leaves the failed stage without its new column", async () => {
  const stage = await createStageDatabase(23, { databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl });
  try {
    await stage.pool.query("INSERT INTO users (phone_number) VALUES ('+2348030000101'),('2348030000101'),('+2348030000102'),('2348030000102')");
    await assert.rejects(stage.runMigrations(24));
    assert.equal((await stage.pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='users' AND column_name='phone_share_group'")).rows[0].n, 0);
  } finally { await stage.drop(); }
});

test("owner acceptance A gives exact SQLSTATE and reviewed constraint names", async () => {
  const stage = await createStageDatabase(23, { databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl });
  try {
    const q = (...args) => stage.pool.query(...args);
    const x = (await q("INSERT INTO users (phone_number) VALUES ('+2348030000001') RETURNING id")).rows[0];
    const y = (await q("INSERT INTO users (phone_number) VALUES ('2348030000001') RETURNING id")).rows[0];
    await stage.runMigrations(24);
    await q("UPDATE users SET phone_number='+2348030000099' WHERE id=$1", [x.id]);
    for (const value of ["+234 803 000 0001", "+2348030000001"]) {
      await assert.rejects(q("UPDATE users SET phone_number=$1 WHERE id=$2", [value, x.id]), (e) => e.code === "23P01" && e.constraint === "users_phone_digits_excl");
    }
    await assert.rejects(q("INSERT INTO users (phone_number) VALUES ('+234 803 000 0001')"), (e) => e.code === "23P01" && e.constraint === "users_phone_digits_excl");
    await assert.rejects(q("INSERT INTO users (phone_number) VALUES ('2348030000001')"), (e) => e.code === "23505" && e.constraint === "users_phone_number_key");
    await assert.rejects(q("UPDATE users SET phone_share_group=gen_random_uuid() WHERE id=$1", [y.id]), (e) => e.code === "23514");
    assert.equal((await q("INSERT INTO users (phone_number,phone_share_group) VALUES ('+2348030000003',gen_random_uuid()) RETURNING phone_share_group")).rows[0].phone_share_group, null);
  } finally { await stage.drop(); }
});

test("owner acceptance B returns a clean conflict, does not consume the code, and retries successfully", async () => {
  const owner = await account({ phone: "+2348030000010" }); const target = "+2348030000011"; const code = await requestChange(owner, target);
  const taker = await account({ phone: target }); const blocked = await confirm(owner, target, code);
  assert.equal(blocked.statusCode, 409); assert.deepEqual(blocked.json(), { code: "phone_in_use", error: "This phone number is already linked to another account." });
  assert.deepEqual((await database.query("SELECT phone_number,phone_verified FROM users WHERE id=$1", [owner.id])).rows[0], { phone_number: owner.phone, phone_verified: true });
  assert.equal((await database.query("SELECT count(*)::int AS n FROM account_phone_changes WHERE user_id=$1", [owner.id])).rows[0].n, 0);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM phone_change_failed_guesses WHERE user_id=$1", [owner.id])).rows[0].n, 0);
  assert.equal((await database.query("SELECT consumed_at IS NULL AS open FROM phone_change_challenges WHERE user_id=$1", [owner.id])).rows[0].open, true);
  noLeak(`${blocked.body}\n${logLines.join("\n")}`, [phoneDigits(target), owner.id, taker.id, "23P01", "23505", "users_phone_digits_excl", "users_phone_number_key", "detail"]);
  await database.query("UPDATE users SET phone_number='+2348030000098' WHERE id=$1", [taker.id]);
  assert.equal((await confirm(owner, target, code)).statusCode, 200);
});

test("G1 request-time formatted conflict and same-digits own number are clean", async () => {
  const owner = await account({ phone: "+2348030000020" }); await account({ phone: "+2348030000021" });
  const inUse = await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: "+234 803 000 0021" } });
  assert.equal(inUse.statusCode, 409); assert.equal(inUse.json().code, "phone_in_use");
  const own = await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: "+234 803 000 0020" } });
  assert.equal(own.statusCode, 400); assert.equal(own.json().error, "That is already your number.");
});

test("G2 durable limits, lockout recovery, and superseded codes", async () => {
  const owner = await account(); const target = "+2348030000030";
  for (let i = 0; i < 5; i += 1) await requestChange(owner, target);
  const old = codes.at(-1).code;
  assert.equal((await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: target } })).statusCode, 429);
  for (let i = 0; i < 5; i += 1) assert.equal((await confirm(owner, target, "000000")).statusCode, 400);
  assert.equal((await confirm(owner, target, old)).statusCode, 429);
  await database.query("UPDATE phone_change_failed_guesses SET created_at=NOW()-INTERVAL '61 minutes' WHERE user_id=$1", [owner.id]);
  await database.query("UPDATE phone_change_challenges SET created_at=NOW()-INTERVAL '61 minutes' WHERE user_id=$1", [owner.id]);
  const fresh = await requestChange(owner, target);
  assert.equal((await confirm(owner, target, old)).statusCode, 400);
  assert.equal((await confirm(owner, target, fresh)).statusCode, 200);
});

test("G2 failed phone-change guesses share one account-wide budget across replacement codes", async () => {
  const owner = await account({ phone: "+2348030000031" });
  const firstTarget = "+2348030000032"; const secondTarget = "+2348030000033"; const thirdTarget = "+2348030000034";
  await requestChange(owner, firstTarget);
  for (let i = 0; i < 2; i += 1) assert.equal((await confirm(owner, firstTarget, "000000")).statusCode, 400);
  await requestChange(owner, secondTarget);
  for (let i = 0; i < 2; i += 1) assert.equal((await confirm(owner, secondTarget, "000000")).statusCode, 400);
  const thirdCode = await requestChange(owner, thirdTarget);
  assert.equal((await confirm(owner, thirdTarget, "000000")).statusCode, 400);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM phone_change_failed_guesses WHERE user_id=$1", [owner.id])).rows[0].n, 5);
  assert.equal((await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: "+2348030000035" } })).statusCode, 429);
  assert.equal((await confirm(owner, thirdTarget, thirdCode)).statusCode, 429);
  assert.equal((await database.query("SELECT phone_number FROM users WHERE id=$1", [owner.id])).rows[0].phone_number, owner.phone);
});

test("G3 digest is not OTP/SHA-256 and is bound to challenge and target", async () => {
  const owner = await account(); const target = "+2348030000040"; const code = await requestChange(owner, target);
  const row = (await database.query("SELECT id,code_digest FROM phone_change_challenges WHERE user_id=$1", [owner.id])).rows[0];
  assert.notEqual(row.code_digest, hashOtp(owner.address, code));
  assert.notEqual(row.code_digest, crypto.createHash("sha256").update(`${row.id}:${owner.id}:${phoneDigits(target)}:${code}`).digest("hex"));
  assert.notEqual(row.code_digest, phoneChangeCodeDigest({ challengeId: crypto.randomUUID(), userId: owner.id, newPhoneDigits: phoneDigits(target), code }));
  assert.equal((await confirm(owner, "+2348030000041", code)).statusCode, 400);
});

test("confirm updates users and profiles, records no phone in audit, then sends a number-free notice", async () => {
  const owner = await account(); const target = "+2348030000050"; const code = await requestChange(owner, target);
  assert.equal((await confirm(owner, target, code)).statusCode, 200);
  assert.deepEqual((await database.query("SELECT phone_number,phone_verified FROM users WHERE id=$1", [owner.id])).rows[0], { phone_number: target, phone_verified: false });
  assert.equal((await database.query("SELECT phone_number FROM profiles WHERE user_id=$1", [owner.id])).rows[0].phone_number, target);
  const audit = (await database.query("SELECT row_to_json(account_phone_changes)::text AS row FROM account_phone_changes WHERE user_id=$1", [owner.id])).rows[0].row;
  assert.equal(/phone/i.test(audit), false); assert.equal(notices.length, 1); noLeak(JSON.stringify(notices[0]), [phoneDigits(owner.phone), phoneDigits(target)]);
});

test("G1 concurrent registration and confirm for formatted same digits have one winner and no partial loser", async () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    await resetTestDatabase(database); codes.length = 0; notices.length = 0; logLines.length = 0;
    const suffix = (6100 + iteration).toString().padStart(4, "0");
    const owner = await account({ phone: `+234803000${suffix}` }); const target = `+234803100${suffix}`;
    const changeCode = await requestChange(owner, target);
    const registeringEmail = email(); const registeringDevice = `m2-register-${crypto.randomUUID()}`;
    // No spaces: current registration validation counts them toward its legacy 15-character limit.
    const registrationPhone = phoneDigits(target);
    const otp = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { channel: "email", email: registeringEmail, phone_number: registrationPhone } });
    assert.equal(otp.statusCode, 200, `iteration ${iteration}: ${otp.body}`);
    const [registration, changed] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/otp/verify", payload: { channel: "email", email: registeringEmail, phone_number: registrationPhone, code: otp.json().dev_code, device_identity: registeringDevice, public_key: "register-key" } }),
      confirm(owner, target, changeCode)
    ]);
    assert.equal([registration.statusCode, changed.statusCode].filter((status) => status === 200).length, 1, `iteration ${iteration}: ${registration.body}\n${changed.body}`);
    assert.ok([registration.statusCode, changed.statusCode].every((status) => status === 200 || status === 409), `iteration ${iteration}: ${registration.body}\n${changed.body}`);
    const holders = await database.query("SELECT id FROM users WHERE regexp_replace(phone_number, '[^0-9]', '', 'g')=$1", [phoneDigits(target)]);
    assert.equal(holders.rowCount, 1, `iteration ${iteration}`);
    if (changed.statusCode === 409) {
      assert.equal((await database.query("SELECT consumed_at IS NULL AS open FROM phone_change_challenges WHERE user_id=$1", [owner.id])).rows[0].open, true);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM account_phone_changes WHERE user_id=$1", [owner.id])).rows[0].n, 0);
    } else {
      assert.equal((await database.query("SELECT count(*)::int AS n FROM users WHERE email=$1", [registeringEmail])).rows[0].n, 0, `iteration ${iteration}: losing registration left an account`);
    }
  }
});

test("G1 two simultaneous confirms for one new number leave one code unconsumed", async () => {
  const left = await account({ phone: "+2348030000062" }); const right = await account({ phone: "+2348030000063" }); const target = "+2348030000064";
  const leftCode = await requestChange(left, target); const rightCode = await requestChange(right, target);
  const [a, b] = await Promise.all([confirm(left, target, leftCode), confirm(right, target, rightCode)]);
  assert.equal([a.statusCode, b.statusCode].filter((status) => status === 200).length, 1, `${a.body}\n${b.body}`);
  assert.equal([a.statusCode, b.statusCode].filter((status) => status === 409).length, 1);
  const loser = a.statusCode === 409 ? left : right;
  assert.equal((await database.query("SELECT consumed_at IS NULL AS open FROM phone_change_challenges WHERE user_id=$1", [loser.id])).rows[0].open, true);
});

test("two overlapping changes on one account serialize to one complete users/profiles change", async () => {
  const owner = await account({ phone: "+23480300000645" }); const firstTarget = "+23480300000646"; const secondTarget = "+23480300000647";
  const [first, second] = await Promise.all([
    app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: firstTarget } }),
    app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: secondTarget } })
  ]);
  assert.ok([first.statusCode, second.statusCode].every((status) => status === 200));
  const challenges = (await database.query("SELECT new_phone_number, id, code_digest, superseded_at FROM phone_change_challenges WHERE user_id=$1 ORDER BY created_at,id", [owner.id])).rows;
  assert.equal(challenges.length, 2);
  const active = challenges.find((challenge) => challenge.superseded_at === null);
  const activeCode = codes.map((entry) => entry.code).find((candidate) => phoneChangeCodeDigest({ challengeId: active.id, userId: owner.id, newPhoneDigits: phoneDigits(active.new_phone_number), code: candidate }) === active.code_digest);
  assert.match(activeCode, /^\d{6}$/);
  const responses = await Promise.all(challenges.map((challenge) => confirm(owner, challenge.new_phone_number, challenge.id === active.id ? activeCode : "000000")));
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 400).length, 1);
  const user = (await database.query("SELECT phone_number FROM users WHERE id=$1", [owner.id])).rows[0];
  const profile = (await database.query("SELECT phone_number FROM profiles WHERE user_id=$1", [owner.id])).rows[0];
  assert.equal(user.phone_number, active.new_phone_number); assert.equal(profile.phone_number, active.new_phone_number);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM account_phone_changes WHERE user_id=$1", [owner.id])).rows[0].n, 1);
});

test("G2 ten simultaneous requests and guesses respect the durable per-account caps", async () => {
  const owner = await account({ phone: "+2348030000065" }); const target = "+2348030000066";
  const requests = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: target } })));
  assert.equal(requests.filter((response) => response.statusCode === 200).length, 5);
  assert.equal(requests.filter((response) => response.statusCode === 429).length, 5);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM phone_change_challenges WHERE user_id=$1", [owner.id])).rows[0].n, 5);
  const guesses = await Promise.all(Array.from({ length: 10 }, () => confirm(owner, target, "000000")));
  assert.equal(guesses.filter((response) => response.statusCode === 400).length, 5);
  assert.equal(guesses.filter((response) => response.statusCode === 429).length, 5);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM phone_change_failed_guesses WHERE user_id=$1", [owner.id])).rows[0].n, 5);
});

test("R3 paused email sign-in updates X by id after X changes numbers", async () => {
  const x = await account({ phone: "+2348030000067" }); const newPhone = "+2348030000068";
  const signInCode = await requestEmailSignIn({ address: x.address, phone: x.phone });
  const pause = poolRecorder.pauseNext(/UPDATE\s+users\s+SET\s+email\s+=\s+\$2,\s*email_verified\s+=\s+TRUE\s+WHERE\s+/i);
  const pendingSignIn = verifyEmailSignIn({ address: x.address, phone: x.phone, code: signInCode });
  await pause.reached;
  const changeCode = await requestChange(x, newPhone);
  assert.equal((await confirm(x, newPhone, changeCode)).statusCode, 200);
  pause.release();
  const signIn = await pendingSignIn;
  assert.equal(signIn.statusCode, 200, signIn.body);
  assert.deepEqual((await database.query("SELECT phone_number,email,email_verified FROM users WHERE id=$1", [x.id])).rows[0], { phone_number: newPhone, email: x.address, email_verified: true });
});

test("R3 paused email sign-in cannot update Z after Z claims X's old number", async () => {
  const x = await account({ phone: "+2348030000073" }); const newPhone = "+2348030000074";
  const signInCode = await requestEmailSignIn({ address: x.address, phone: x.phone });
  const pause = poolRecorder.pauseNext(/UPDATE\s+users\s+SET\s+email\s+=\s+\$2,\s*email_verified\s+=\s+TRUE\s+WHERE\s+/i);
  const pendingSignIn = verifyEmailSignIn({ address: x.address, phone: x.phone, code: signInCode });
  await pause.reached;
  const changeCode = await requestChange(x, newPhone);
  assert.equal((await confirm(x, newPhone, changeCode)).statusCode, 200);
  const z = (await database.query("INSERT INTO users (phone_number,phone_verified) VALUES ($1,TRUE) RETURNING id,email,email_verified", [x.phone])).rows[0];
  pause.release();
  const signIn = await pendingSignIn;
  assert.equal(signIn.statusCode, 200, signIn.body);
  assert.deepEqual((await database.query("SELECT email,email_verified FROM users WHERE id=$1", [z.id])).rows[0], { email: null, email_verified: false });
  assert.deepEqual((await database.query("SELECT phone_number,email,email_verified FROM users WHERE id=$1", [x.id])).rows[0], { phone_number: newPhone, email: x.address, email_verified: true });
});

test("G2 limits survive a new Fastify instance with a fresh in-memory limiter", async () => {
  const owner = await account({ phone: "+2348030000069" }); const target = "+2348030000070"; const code = await requestChange(owner, target);
  for (let i = 0; i < 5; i += 1) assert.equal((await confirm(owner, target, "000000")).statusCode, 400);
  const restarted = Fastify({ logger: false });
  try {
    await registerAccountRoutes(restarted, { sendPhoneChangeEmail: async () => {}, sendPhoneChangeNotice: async () => {} }); await restarted.ready();
    const response = await restarted.inject({ method: "POST", url: "/account/phone-change/confirm", headers: headers(owner), payload: { new_phone_number: target, code } });
    assert.equal(response.statusCode, 429, response.body);
  } finally { await restarted.close(); }
});

test("confirm changes only current user/profile phones and leaves snapshot rows byte-identical", async () => {
  const owner = await account({ phone: "+2348030000071" }); const target = "+2348030000072";
  const rotated = `m2-rotated-${crypto.randomUUID()}`;
  const vtId = `m2-snapshot-${crypto.randomUUID()}`;
  const recoveryId = crypto.randomUUID();
  await database.query("INSERT INTO device_identities (device_identity,public_key,phone_number,user_id) VALUES ($1,'snapshot-key',$2,$3)", [rotated, owner.phone, owner.id]);
  await database.query("INSERT INTO key_rotation_events (old_device_identity,new_device_identity,phone_number,user_id,rotation_receipt) VALUES ($1,$2,$3,$4,'snapshot-receipt')", [owner.device, rotated, owner.phone, owner.id]);
  await database.query("INSERT INTO attestations (vt_id,device_identity,phone_number,user_id,ledger_root_hash,window_start,window_end,entry_count,server_signature) VALUES ($1,$2,$3,$4,'snapshot-root',NOW(),NOW(),1,'snapshot-signature')", [vtId, owner.device, owner.phone, owner.id]);
  await database.query("INSERT INTO payments (phone_number,user_id,device_identity,reference,amount_kobo,tier,window_days,vt_id) VALUES ($1,$2,$3,$4,100,'basic',30,$5)", [owner.phone, owner.id, owner.device, `m2-payment-${crypto.randomUUID()}`, vtId]);
  await database.query("INSERT INTO rotation_challenges (phone_number,user_id,old_device_identity,challenge_nonce,expires_at) VALUES ($1,$2,$3,$4,NOW()+INTERVAL '1 hour')", [owner.phone, owner.id, owner.device, `m2-challenge-${crypto.randomUUID()}`]);
  await database.query("INSERT INTO ledger_entries (device_identity,entry_id,entry_hash,prev_entry_hash,signature,confirmed_at,payload) VALUES ($1,1,'snapshot-entry','0','snapshot-signature',NOW(),'{\"snapshot\":true}')", [owner.device]);
  await database.query("INSERT INTO recovery_sessions (recovery_id,device_identity,user_id,state,app_version,local_summary,lease_expires_at) VALUES ($1,$2,$3,'open','snapshot-test','{\"records\":1}',NOW()+INTERVAL '1 hour')", [recoveryId, owner.device, owner.id]);
  await database.query("INSERT INTO recovery_parts (recovery_id,part_no,sha256,payload) VALUES ($1,0,$2,'{\"records\":[],\"queue\":[]}')", [recoveryId, crypto.createHash("sha256").update("m2-snapshot-part").digest("hex")]);
  await database.query("INSERT INTO recovery_audit_events (device_identity,recovery_id,kind,detail) VALUES ($1,$2,'recovery_started','{\"snapshot\":true}')", [owner.device, recoveryId]);
  const tables = ["device_identities", "key_rotation_events", "attestations", "payments", "rotation_challenges", "ledger_entries", "recovery_sessions", "recovery_parts", "recovery_audit_events"];
  const rowsFor = async (table) => {
    const byTable = {
      // Authenticated requests update this existing device-activity bookkeeping. Exclude only
      // last_seen_at and updated_at; phone_number and every other device column remain exact.
      device_identities: ["user_id=$1", [owner.id], "device_identity", "(row_to_json(x)::jsonb - 'last_seen_at' - 'updated_at')::text"],
      key_rotation_events: ["user_id=$1", [owner.id], "id"],
      attestations: ["user_id=$1", [owner.id], "vt_id"],
      payments: ["user_id=$1", [owner.id], "id"],
      rotation_challenges: ["user_id=$1", [owner.id], "id"],
      ledger_entries: ["device_identity=$1", [owner.device], "device_identity, entry_id"],
      recovery_sessions: ["user_id=$1", [owner.id], "recovery_id"],
      recovery_parts: ["recovery_id IN (SELECT recovery_id FROM recovery_sessions WHERE user_id=$1)", [owner.id], "recovery_id, part_no"],
      recovery_audit_events: ["device_identity=$1", [owner.device], "id"]
    };
    const [where, params, orderBy, projection = "row_to_json(x)::text"] = byTable[table];
    return (await database.query(`SELECT ${projection} AS row FROM ${table} x WHERE ${where} ORDER BY ${orderBy}`, params)).rows.map((row) => row.row);
  };
  const before = {};
  for (const table of tables) { before[table] = await rowsFor(table); assert.ok(before[table].length, `${table} must be seeded`); }
  assert.equal((await confirm(owner, target, await requestChange(owner, target))).statusCode, 200);
  for (const table of tables) {
    assert.deepEqual(await rowsFor(table), before[table], table);
  }
});

test("notice delivery failure is recorded without rolling back the successful change", async () => {
  const owner = await account({ phone: "+2348030000073" }); const target = "+2348030000074"; const localCodes = [];
  const failing = Fastify({ logger: false });
  try {
    await registerAccountRoutes(failing, { sendPhoneChangeEmail: async (_to, code) => localCodes.push(code), sendPhoneChangeNotice: async () => { throw new Error("delivery failed"); } }); await failing.ready();
    const requested = await failing.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(owner), payload: { new_phone_number: target } });
    assert.equal(requested.statusCode, 200, requested.body);
    const response = await failing.inject({ method: "POST", url: "/account/phone-change/confirm", headers: headers(owner), payload: { new_phone_number: target, code: localCodes[0] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await database.query("SELECT phone_number FROM users WHERE id=$1", [owner.id])).rows[0].phone_number, target);
    assert.equal((await database.query("SELECT notice_sent FROM account_phone_changes WHERE user_id=$1", [owner.id])).rows[0].notice_sent, false);
  } finally { await failing.close(); }
});
