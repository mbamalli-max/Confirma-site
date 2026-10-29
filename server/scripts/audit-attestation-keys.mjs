#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config, parseServerAttestationRetiredKeys } from "../src/config.js";
import {
  ATTESTATION_SCOPE,
  ATTESTATION_SCOPE_DESCRIPTION,
  buildAttestationPayload,
  exportPublishedVerificationKey,
  getVerificationKeyKid,
  signatureMatchesPublicKey
} from "../src/attestation-signing.js";

const { Pool } = pg;

function parseArguments(argv) {
  let retiredKeyFile = null;
  let deadline = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--retired-key-file") {
      retiredKeyFile = argv[index + 1] || null;
      index += 1;
    } else if (argument === "--deadline") {
      deadline = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error("Usage: audit-attestation-keys.mjs [--retired-key-file PATH] --deadline ISO_UTC");
    }
  }
  if (!deadline) {
    throw new Error("A retirement deadline is required.");
  }
  const deadlineDate = new Date(deadline);
  if (!Number.isFinite(deadlineDate.getTime()) || !String(deadline).endsWith("Z")) {
    throw new Error("The retirement deadline must be a valid UTC timestamp.");
  }
  return { retiredKeyFile, deadline: deadlineDate };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function buildStoredPayload(row) {
  return buildAttestationPayload({
    vt_id: row.vt_id,
    device_fingerprint: String(row.device_identity || "").substring(0, 8),
    ledger_root_hash: row.ledger_root_hash,
    entry_count: row.entry_count,
    window_start: row.window_start,
    window_end: row.window_end,
    issued_at: row.issued_at,
    status: row.status,
    attestation_scope: row.attestation_scope || ATTESTATION_SCOPE,
    scope_description: row.scope_description || ATTESTATION_SCOPE_DESCRIPTION
  });
}

export async function auditAttestationKeys({
  pool,
  retiredPublicKeyPem,
  deadline
}) {
  if (/PRIVATE KEY/i.test(String(retiredPublicKeyPem || ""))) {
    throw new Error("The retired key input must contain a public key only.");
  }
  getVerificationKeyKid(retiredPublicKeyPem);
  const activePublicKeyPem = exportPublishedVerificationKey().public_key_spki_pem;
  const deadlineDate = new Date(deadline);
  const windowStart = new Date(deadlineDate.getTime() - 2 * 60 * 60 * 1000);
  const counts = {
    retired_before_deadline: 0,
    retired_at_or_after_deadline: 0,
    active: 0,
    verified_by_neither: 0
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(
      `
        SELECT
          vt_id, device_identity, ledger_root_hash, entry_count,
          window_start, window_end, issued_at, status,
          attestation_scope, scope_description, server_signature
        FROM attestations
        WHERE issued_at >= $1
        ORDER BY issued_at ASC
      `,
      [windowStart]
    );
    for (const row of result.rows) {
      const payload = buildStoredPayload(row);
      if (signatureMatchesPublicKey(payload, row.server_signature, retiredPublicKeyPem)) {
        if (new Date(row.issued_at).getTime() < deadlineDate.getTime()) {
          counts.retired_before_deadline += 1;
        } else {
          counts.retired_at_or_after_deadline += 1;
        }
      } else if (signatureMatchesPublicKey(payload, row.server_signature, activePublicKeyPem)) {
        counts.active += 1;
      } else {
        counts.verified_by_neither += 1;
      }
    }
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const { retiredKeyFile, deadline } = parseArguments(process.argv.slice(2));
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!config.serverAttestationPrivateKeyPem) {
    throw new Error("SERVER_ATTESTATION_PRIVATE_KEY_PEM is required.");
  }
  config.serverAttestationRetiredKeys = parseServerAttestationRetiredKeys(
    config.serverAttestationRetiredKeysRaw,
    { activePrivateKeyPem: config.serverAttestationPrivateKeyPem }
  );
  const retiredPublicKeyPem = retiredKeyFile
    ? await readFile(retiredKeyFile, "utf8")
    : await readStdin();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 1
  });
  try {
    const counts = await auditAttestationKeys({ pool, retiredPublicKeyPem, deadline });
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
