import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { verifyEntrySignature } from "../crypto-verify.js";
import { withTransaction } from "../db.js";

const EMPTY_HASH = "0".repeat(64);

async function markDeviceStatus(client, deviceIdentity, status) {
  await client.query(
    `
      UPDATE device_identities
      SET status = $2, updated_at = NOW()
      WHERE device_identity = $1
    `,
    [deviceIdentity, status]
  );
}

export async function registerSyncRoutes(app) {
  app.post("/sync/entries", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const deviceIdentity = String(request.body?.device_identity || "").trim();
    const entries = Array.isArray(request.body?.entries) ? request.body.entries : [];
    // request.body.public_key is accepted for client compatibility but intentionally ignored;
    // signature verification uses the key pinned at registration time.

    if (!deviceIdentity || !entries.length) {
      return reply.code(400).send({ error: "device_identity and entries are required." });
    }

    try {
      const result = await withTransaction(async (client) => {
        const pinnedDeviceResult = await client.query(
          `
            SELECT phone_number, public_key, status, receipt_counter, last_synced_entry_id, revoked_at
            FROM device_identities
            WHERE device_identity = $1
            LIMIT 1
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
              await markDeviceStatus(client, deviceIdentity, "FORKED");
              throw Object.assign(new Error("Fork detected for an existing entry id."), { statusCode: 409 });
            }
            expectedPrevHash = existing.entry_hash;
            lastSyncedEntryId = Math.max(lastSyncedEntryId, Number(entry.id));
            continue;
          }

          if (entry.prev_entry_hash !== expectedPrevHash) {
            await markDeviceStatus(client, deviceIdentity, "FORKED");
            throw Object.assign(new Error("Hash chain continuity failed. Device marked FORKED."), { statusCode: 409 });
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

        await client.query(
          `
            UPDATE device_identities
            SET
              status = 'ACTIVE',
              last_synced_entry_id = $2,
              receipt_counter = $3,
              updated_at = NOW()
            WHERE device_identity = $1
          `,
          [deviceIdentity, lastSyncedEntryId, receiptCounter]
        );

        return {
          ok: true,
          synced_count: syncedCount,
          receipt_counter: receiptCounter,
          last_synced_entry_id: lastSyncedEntryId,
          server_receipt: receipt,
          fork_status: "NORMAL"
        };
      });

      return result;
    } catch (error) {
      return reply.code(error.statusCode || 500).send({
        error: error.message || "Sync failed."
      });
    }
  });
}
