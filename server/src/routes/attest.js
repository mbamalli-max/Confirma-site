import crypto from "node:crypto";
import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { query } from "../db.js";

const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "https://confirma-site.vercel.app";

export async function registerAttestRoutes(app) {
  app.post("/attest", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const windowDays = Number(request.body?.window_days) || 30;

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

    // Query ledger entries in the window
    const entriesResult = await query(
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

    // Generate vt_id
    const vtId = crypto.randomBytes(16).toString("hex");

    // HMAC server signature
    const serverSignature = buildReceiptSignature([
      vtId,
      deviceIdentity,
      ledgerRootHash,
      windowStart.toISOString(),
      windowEnd.toISOString()
    ]);

    const issuedAt = new Date();

    // Insert attestation
    await query(
      `
        INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature, status, issued_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VALID', $9)
      `,
      [vtId, deviceIdentity, auth.phone_number, ledgerRootHash, windowStart.toISOString(), windowEnd.toISOString(), entryCount, serverSignature, issuedAt.toISOString()]
    );

    const verifyUrl = `${VERIFY_BASE_URL}/verify/${vtId}`;

    return {
      ok: true,
      vt_id: vtId,
      ledger_root_hash: ledgerRootHash,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      entry_count: entryCount,
      issued_at: issuedAt.toISOString(),
      verify_url: verifyUrl
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

    // Look up attestation
    const attestResult = await query(
      `SELECT * FROM attestations WHERE vt_id = $1 LIMIT 1`,
      [vtId]
    );

    const attestation = attestResult.rows[0];
    if (!attestation) {
      return { status: "UNKNOWN" };
    }

    // Re-verify server_signature
    const expectedSignature = buildReceiptSignature([
      attestation.vt_id,
      attestation.device_identity,
      attestation.ledger_root_hash,
      new Date(attestation.window_start).toISOString(),
      new Date(attestation.window_end).toISOString()
    ]);

    if (expectedSignature !== attestation.server_signature) {
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
      entry_count: attestation.entry_count,
      key_rotation_events: rotationResult.rows[0]?.rotation_count || 0,
      fork_status: forkStatus
    };
  });
}
