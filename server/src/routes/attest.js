import crypto from "node:crypto";
import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { query } from "../db.js";
import {
  ATTESTATION_SCOPE,
  ATTESTATION_SCOPE_DESCRIPTION,
  LEGACY_ATTESTATION_SIGNATURE_ALGORITHM,
  buildAttestationPayload,
  buildAttestationEnvelope,
  exportPublishedVerificationKey,
  getVerificationKeyMetadata,
  verifyAttestationPayload
} from "../attestation-signing.js";

export async function registerAttestRoutes(app) {
  app.get("/.well-known/verification-key.json", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async () => exportPublishedVerificationKey());

  app.post("/attest", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const parsedWindowDays = Number(request.body?.window_days);
    const windowDays = Number.isFinite(parsedWindowDays) && parsedWindowDays >= 0
      ? Math.min(365, Math.floor(parsedWindowDays))
      : 30;

    if (!deviceIdentity) {
      return reply.code(400).send({ error: "device_identity is required." });
    }

    // Validate device belongs to this phone_number
    const deviceResult = await query(
      `SELECT phone_number, status, revoked_at FROM device_identities WHERE device_identity = $1 LIMIT 1`,
      [deviceIdentity]
    );

    const device = deviceResult.rows[0];
    if (!device || device.phone_number !== auth.phone_number) {
      return reply.code(403).send({ error: "Device does not belong to this account." });
    }

    if (device.status !== "ACTIVE") {
      return reply.code(403).send({ error: "Device is not active." });
    }

    if (device.revoked_at) {
      return reply.code(403).send({ error: "Device has been revoked." });
    }

    // Query ledger entries in the window. window_days=0 means full device history.
    const entriesResult = windowDays === 0
      ? await query(
        `
          SELECT entry_hash, confirmed_at
          FROM ledger_entries
          WHERE device_identity = $1
          ORDER BY entry_id ASC
        `,
        [deviceIdentity]
      )
      : await query(
        `
          SELECT entry_hash, confirmed_at
          FROM ledger_entries
          WHERE device_identity = $1
            AND confirmed_at >= NOW() - ($2 || ' days')::interval
          ORDER BY entry_id ASC
        `,
        [deviceIdentity, String(windowDays)]
      );

    if (entriesResult.rows.length === 0) {
      return reply.code(400).send({ error: "No entries in this window." });
    }

    const entries = entriesResult.rows;
    const entryCount = entries.length;
    const ledgerRootHash = entries[entryCount - 1].entry_hash;
    const windowStart = new Date(entries[0].confirmed_at);
    const windowEnd = new Date(entries[entryCount - 1].confirmed_at);

    const vtId = crypto.randomBytes(16).toString("hex");

    const issuedAt = new Date();
    const attestation = buildAttestationEnvelope({
      vt_id: vtId,
      device_identity: deviceIdentity,
      ledger_root_hash: ledgerRootHash,
      entry_count: entryCount,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      issued_at: issuedAt.toISOString(),
      status: "VALID"
    });

    await query(
      `
        INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature, status, issued_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VALID', $9)
      `,
      [
        attestation.vt_id,
        deviceIdentity,
        auth.phone_number,
        attestation.ledger_root_hash,
        attestation.window_start,
        attestation.window_end,
        attestation.entry_count,
        attestation.server_signature,
        attestation.issued_at
      ]
    );

    return {
      ok: true,
      ...attestation
    };
  });

  app.get("/verify/:vt_id", {
    config: {
      rateLimit: {
        max: 100,
        timeWindow: "1 minute"
      }
    }
  }, async (request, reply) => {
    const vtId = String(request.params.vt_id || "").trim();

    if (!vtId) {
      return { status: "UNKNOWN" };
    }

    if (vtId === "demo") {
      const issuedAt = new Date();
      const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const verificationKeyMetadata = getVerificationKeyMetadata();
      const demoAttestation = buildAttestationEnvelope({
        vt_id: "demo",
        device_identity: "demo-device-7f3a91c2b8d4450fa02c9e01",
        device_fingerprint: "7f3a91c2",
        ledger_root_hash: "sha256:demo-ledger-root-8d6b5b0a2e3f4c9d1a7b6e5c4d3f2a1b",
        entry_count: 47,
        window_start: windowStart.toISOString(),
        window_end: issuedAt.toISOString(),
        issued_at: issuedAt.toISOString(),
        status: "VALID",
        verify_url: "https://konfirmata.com/verify/demo"
      });

      return {
        status: demoAttestation.status,
        vt_id: demoAttestation.vt_id,
        attested_at: demoAttestation.issued_at,
        device_fingerprint: demoAttestation.device_fingerprint,
        ledger_root_hash: demoAttestation.ledger_root_hash,
        window_start: demoAttestation.window_start,
        window_end: demoAttestation.window_end,
        entry_count: demoAttestation.entry_count,
        key_rotation_events: 0,
        fork_status: "NORMAL",
        attestation_scope: demoAttestation.attestation_scope,
        scope_description: demoAttestation.scope_description,
        server_signature: demoAttestation.server_signature,
        attestation_payload: demoAttestation.attestation_payload,
        signature_algorithm: verificationKeyMetadata.signature_algorithm,
        verification_key_url: verificationKeyMetadata.verification_key_url,
        is_demo: true
      };
    }

    // Look up attestation
    const attestResult = await query(
      `SELECT * FROM attestations WHERE vt_id = $1 LIMIT 1`,
      [vtId]
    );

    const attestation = attestResult.rows[0];
    if (!attestation) {
      return { status: "UNKNOWN" };
    }

    const attestationPayload = buildAttestationPayload({
      vt_id: attestation.vt_id,
      device_fingerprint: attestation.device_identity.substring(0, 8),
      ledger_root_hash: attestation.ledger_root_hash,
      entry_count: attestation.entry_count,
      window_start: attestation.window_start,
      window_end: attestation.window_end,
      issued_at: attestation.issued_at,
      status: attestation.status,
      attestation_scope: attestation.attestation_scope || ATTESTATION_SCOPE,
      scope_description: attestation.scope_description || ATTESTATION_SCOPE_DESCRIPTION
    });

    const verificationKeyMetadata = getVerificationKeyMetadata();
    let signatureAlgorithm = verificationKeyMetadata.signature_algorithm;
    let verificationKeyUrl = verificationKeyMetadata.verification_key_url;

    if (!verifyAttestationPayload(attestationPayload, attestation.server_signature)) {
      const legacyExpectedSignature = buildReceiptSignature([
        attestation.vt_id,
        attestation.device_identity,
        attestation.ledger_root_hash,
        new Date(attestation.window_start).toISOString(),
        new Date(attestation.window_end).toISOString()
      ]);
      if (legacyExpectedSignature !== attestation.server_signature) {
        return { status: "INVALID" };
      }
      signatureAlgorithm = LEGACY_ATTESTATION_SIGNATURE_ALGORITHM;
      verificationKeyUrl = null;
    }

    if (!attestation.server_signature) {
      return { status: "INVALID" };
    }

    // Look up key rotation events
    const rotationResult = await query(
      `SELECT COUNT(*)::int AS rotation_count FROM key_rotation_events WHERE old_device_identity = $1 OR new_device_identity = $1`,
      [attestation.device_identity]
    );

    // Look up current device status
    const deviceResult = await query(
      `SELECT status FROM device_identities WHERE device_identity = $1 LIMIT 1`,
      [attestation.device_identity]
    );

    const deviceStatus = deviceResult.rows[0]?.status || "UNKNOWN";
    const forkStatus = deviceStatus === "ACTIVE" ? "NORMAL" : deviceStatus;

    return {
      status: attestation.status,
      attested_at: new Date(attestation.issued_at).toISOString(),
      device_fingerprint: attestation.device_identity.substring(0, 8),
      ledger_root_hash: attestation.ledger_root_hash,
      window_start: new Date(attestation.window_start).toISOString(),
      window_end: new Date(attestation.window_end).toISOString(),
      entry_count: Number(attestation.entry_count || 0),
      key_rotation_events: rotationResult.rows[0]?.rotation_count || 0,
      fork_status: forkStatus,
      attestation_scope: attestation.attestation_scope || ATTESTATION_SCOPE,
      scope_description: attestation.scope_description || ATTESTATION_SCOPE_DESCRIPTION,
      server_signature: attestation.server_signature,
      attestation_payload: attestationPayload,
      signature_algorithm: signatureAlgorithm,
      verification_key_url: verificationKeyUrl
    };
  });
}
