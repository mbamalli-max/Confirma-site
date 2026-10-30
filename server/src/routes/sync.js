import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { verifyEntrySignature } from "../crypto-verify.js";
import { withTransaction } from "../db.js";
import { computeLedgerEntryHash } from "../ledger-canonical.js";

const EMPTY_HASH = "0".repeat(64);

// A rejected submission is recorded after its batch rolls back, so the record
// survives the rejection. FORKED means a conflicting submission was detected for
// this device's chain; it does not mean the accepted chain is corrupt.
function integrityError(message, statusCode, kind, entryId, detail) {
  return Object.assign(new Error(message), {
    statusCode,
    integrity: { kind, entryId, detail, markForked: kind !== "hash_mismatch" }
  });
}

async function recordIntegrityEvent(deviceIdentity, integrity) {
  await withTransaction(async (client) => {
    // One writer per device, so overlapping failures stay within the bound.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger-integrity:${deviceIdentity}`]);
    const recent = await client.query(
      `
        SELECT 1
        FROM ledger_integrity_events
        WHERE device_identity = $1
          AND kind = $2
          AND created_at > clock_timestamp() - INTERVAL '1 minute'
        LIMIT 1
      `,
      [deviceIdentity, integrity.kind]
    );
    if (!recent.rows[0]) {
      await client.query(
        `
          INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail, created_at)
          VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
        `,
        [deviceIdentity, integrity.entryId ?? null, integrity.kind, JSON.stringify(integrity.detail || {})]
      );
    }
    if (integrity.markForked) {
      // Only the status changes; ownership, keys and revocation are untouched.
      await client.query(
        `
          UPDATE device_identities
          SET status = 'FORKED', updated_at = NOW()
          WHERE device_identity = $1
            AND revoked_at IS NULL
        `,
        [deviceIdentity]
      );
    }
  });
}

function entryIdOrNull(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export async function registerSyncRoutes(app) {
  app.post("/sync/entries", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const entries = Array.isArray(request.body?.entries) ? request.body.entries : [];
    // request.body.public_key is accepted for client compatibility but intentionally ignored;
    // signature verification uses the key pinned at registration time.

    if (!deviceIdentity || !entries.length) {
      return reply.code(400).send({ error: "device_identity and entries are required." });
    }

    // A session may only submit records for its own device, so one device can't
    // get another device of the same account marked FORKED.
    if (auth.device_identity && deviceIdentity !== auth.device_identity) {
      return reply.code(403).send({ error: "Device does not match this session." });
    }

    try {
      const result = await withTransaction(async (client) => {
        const pinnedDeviceResult = await client.query(
          `
            SELECT phone_number, public_key, status, receipt_counter, last_synced_entry_id, revoked_at
            FROM device_identities
            WHERE device_identity = $1
            LIMIT 1
            FOR UPDATE
          `,
          [deviceIdentity]
        );
        const device = pinnedDeviceResult.rows[0];

        if (!device) {
          throw Object.assign(
            new Error("Device not registered. Complete OTP verification first."),
            { statusCode: 401 }
          );
        }

        if (device.phone_number !== auth.phone_number) {
          throw Object.assign(new Error("Device belongs to another account."), { statusCode: 403 });
        }

        if (device.revoked_at) {
          throw Object.assign(new Error("device_revoked"), { statusCode: 401 });
        }

        const pinnedPublicKey = device.public_key;

        const lastEntryResult = await client.query(
          `
            SELECT entry_id, entry_hash
            FROM ledger_entries
            WHERE device_identity = $1
            ORDER BY entry_id DESC
            LIMIT 1
          `,
          [deviceIdentity]
        );

        let expectedPrevHash = lastEntryResult.rows[0]?.entry_hash || EMPTY_HASH;
        let syncedCount = 0;
        let lastSyncedEntryId = Number(device?.last_synced_entry_id || 0);

        for (const entry of entries) {
          const existingResult = await client.query(
            `
              SELECT entry_hash
              FROM ledger_entries
              WHERE device_identity = $1 AND entry_id = $2
              LIMIT 1
            `,
            [deviceIdentity, entry.id]
          );

          const existing = existingResult.rows[0];
          if (existing) {
            if (existing.entry_hash !== entry.entry_hash) {
              throw integrityError("Fork detected for an existing entry id.", 409, "fork_id_conflict", entryIdOrNull(entry.id), {
                stored_entry_hash: existing.entry_hash,
                received_entry_hash: String(entry.entry_hash || "")
              });
            }
            expectedPrevHash = existing.entry_hash;
            lastSyncedEntryId = Math.max(lastSyncedEntryId, Number(entry.id));
            continue;
          }

          if (entry.prev_entry_hash !== expectedPrevHash) {
            throw integrityError("Hash chain continuity failed. Device marked FORKED.", 409, "fork_continuity", entryIdOrNull(entry.id), {
              expected_prev_entry_hash: expectedPrevHash,
              received_prev_entry_hash: String(entry.prev_entry_hash || ""),
              received_entry_hash: String(entry.entry_hash || "")
            });
          }

          // The stored record must be the one that was hashed and signed.
          const computedHash = computeLedgerEntryHash(entry);
          if (computedHash !== entry.entry_hash) {
            throw integrityError("entry_hash_mismatch", 400, "hash_mismatch", entryIdOrNull(entry.id), {
              received_entry_hash: String(entry.entry_hash || ""),
              computed_entry_hash: computedHash
            });
          }

          if (!verifyEntrySignature(pinnedPublicKey, entry.entry_hash, entry.signature)) {
            throw Object.assign(new Error("Signature verification failed."), { statusCode: 400 });
          }

          await client.query(
            `
              INSERT INTO ledger_entries (
                device_identity,
                entry_id,
                entry_hash,
                prev_entry_hash,
                signature,
                evidence_level,
                confirmed_at,
                synced_at,
                public_key_fingerprint,
                payload
              )
              VALUES ($1, $2, $3, $4, $5, $6, TO_TIMESTAMP($7), NOW(), $8, $9::jsonb)
            `,
            [
              deviceIdentity,
              entry.id,
              entry.entry_hash,
              entry.prev_entry_hash,
              entry.signature,
              "server_attested",
              Number(entry.confirmed_at || 0),
              entry.public_key_fingerprint || null,
              JSON.stringify(entry)
            ]
          );

          expectedPrevHash = entry.entry_hash;
          syncedCount += 1;
          lastSyncedEntryId = Math.max(lastSyncedEntryId, Number(entry.id));
        }

        const receiptCounter = Number(device?.receipt_counter || 0) + 1;
        const receipt = buildReceiptSignature([
          deviceIdentity,
          String(lastSyncedEntryId),
          String(receiptCounter)
        ]);

        const statusResult = await client.query(
          `
            UPDATE device_identities
            SET
              -- Only an active device is refreshed; FORKED, ROTATED and others stay as they are.
              status = CASE WHEN status IS NULL OR status = 'ACTIVE' THEN 'ACTIVE' ELSE status END,
              last_synced_entry_id = $2,
              receipt_counter = $3,
              updated_at = NOW()
            WHERE device_identity = $1
            RETURNING status
          `,
          [deviceIdentity, lastSyncedEntryId, receiptCounter]
        );
        const forkStatus = statusResult.rows[0]?.status === "FORKED" ? "FORKED" : "NORMAL";

        return {
          ok: true,
          synced_count: syncedCount,
          receipt_counter: receiptCounter,
          last_synced_entry_id: lastSyncedEntryId,
          server_receipt: receipt,
          fork_status: forkStatus
        };
      });

      return result;
    } catch (error) {
      if (error.integrity) {
        try {
          await recordIntegrityEvent(deviceIdentity, error.integrity);
        } catch (recordError) {
          // Fail closed: without a durable record the rejection isn't reported as
          // handled; the app keeps its queue and retries.
          request.log?.error?.({ err: recordError }, "Integrity event could not be recorded.");
          return reply.code(503).send({ error: "integrity_record_unavailable" });
        }
      }
      return reply.code(error.statusCode || 500).send({
        error: error.message || "Sync failed."
      });
    }
  });
}
