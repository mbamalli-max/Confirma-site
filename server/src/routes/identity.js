import crypto from "node:crypto";
import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { verifyEntrySignature } from "../crypto-verify.js";
import { query, withTransaction } from "../db.js";

export async function registerIdentityRoutes(app) {
  app.post("/identity/rotate/challenge", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const oldDeviceIdentity = String(request.body?.old_device_identity || "").trim();
    if (!oldDeviceIdentity) {
      return reply.code(400).send({ error: "old_device_identity is required." });
    }

    const deviceResult = await query(
      `
        SELECT 1
        FROM device_identities
        WHERE device_identity = $1 AND phone_number = $2 AND revoked_at IS NULL
        LIMIT 1
      `,
      [oldDeviceIdentity, auth.phone_number]
    );

    if (deviceResult.rowCount === 0) {
      return reply.code(403).send({ error: "Device not available for rotation." });
    }

    const nonce = crypto.randomBytes(32).toString("base64");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await query(
      `
        INSERT INTO rotation_challenges (phone_number, old_device_identity, challenge_nonce, expires_at)
        VALUES ($1, $2, $3, $4)
      `,
      [auth.phone_number, oldDeviceIdentity, nonce, expiresAt.toISOString()]
    );

    return { challenge_nonce: nonce, expires_at: expiresAt.toISOString() };
  });

  app.post("/identity/rotate", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const oldDeviceIdentity = String(request.body?.old_device_identity || "").trim();
    const newDeviceIdentity = String(request.body?.new_device_identity || "").trim();
    const newPublicKey = String(request.body?.new_public_key || "").trim();
    const challengeNonce = String(request.body?.challenge_nonce || "").trim();
    const challengeSignature = String(request.body?.challenge_signature || "").trim();

    if (!oldDeviceIdentity || !newDeviceIdentity || !newPublicKey) {
      return reply.code(400).send({ error: "old_device_identity, new_device_identity, and new_public_key are required." });
    }

    if (!challengeNonce || !challengeSignature) {
      return reply.code(400).send({ error: "challenge_nonce and challenge_signature are required." });
    }

    try {
      const result = await withTransaction(async (client) => {
        // Verify old device belongs to this account and is still active.
        const existingDeviceResult = await client.query(
          `
            SELECT 1
            FROM device_identities
            WHERE device_identity = $1 AND phone_number = $2 AND revoked_at IS NULL
            LIMIT 1
          `,
          [oldDeviceIdentity, auth.phone_number]
        );
        if (existingDeviceResult.rowCount === 0) {
          throw Object.assign(new Error("Device not found for this account."), { statusCode: 403 });
        }

        // Validate and atomically consume the challenge.
        const challengeResult = await client.query(
          `
            SELECT id, phone_number, old_device_identity, expires_at, consumed_at
            FROM rotation_challenges
            WHERE challenge_nonce = $1
            FOR UPDATE
          `,
          [challengeNonce]
        );
        const challenge = challengeResult.rows[0];

        if (
          !challenge ||
          challenge.phone_number !== auth.phone_number ||
          challenge.old_device_identity !== oldDeviceIdentity ||
          challenge.consumed_at ||
          new Date(challenge.expires_at) <= new Date()
        ) {
          throw Object.assign(new Error("Invalid or expired rotation challenge."), { statusCode: 401 });
        }

        // Verify challenge signature against the OLD device's pinned public key.
        // verifyEntrySignature treats its second argument as an arbitrary UTF-8 payload;
        // the function name is entry-hash-specific but the implementation is payload-agnostic.
        const oldKeyResult = await client.query(
          `
            SELECT public_key
            FROM device_identities
            WHERE device_identity = $1
            LIMIT 1
          `,
          [oldDeviceIdentity]
        );
        const oldPublicKey = oldKeyResult.rows[0]?.public_key;
        if (!oldPublicKey) {
          throw Object.assign(new Error("Old device key not found."), { statusCode: 401 });
        }

        const message = `${challengeNonce}|${newDeviceIdentity}|${newPublicKey}`;
        if (!verifyEntrySignature(oldPublicKey, message, challengeSignature)) {
          throw Object.assign(new Error("Challenge signature verification failed."), { statusCode: 401 });
        }

        // Consume the challenge.
        await client.query(
          `UPDATE rotation_challenges SET consumed_at = NOW() WHERE id = $1`,
          [challenge.id]
        );

        // Register new device.
        await client.query(
          `
            INSERT INTO device_identities (device_identity, public_key, phone_number, status)
            VALUES ($1, $2, $3, 'ACTIVE')
            ON CONFLICT (device_identity)
            DO UPDATE SET
              public_key = EXCLUDED.public_key,
              phone_number = EXCLUDED.phone_number,
              updated_at = NOW()
          `,
          [newDeviceIdentity, newPublicKey, auth.phone_number]
        );

        // Mark old device as rotated.
        await client.query(
          `
            UPDATE device_identities
            SET status = 'ROTATED', rotated_to = $2, updated_at = NOW()
            WHERE device_identity = $1
          `,
          [oldDeviceIdentity, newDeviceIdentity]
        );

        const rotationReceipt = buildReceiptSignature([
          oldDeviceIdentity,
          newDeviceIdentity,
          auth.phone_number,
          new Date().toISOString()
        ]);

        await client.query(
          `
            INSERT INTO key_rotation_events (
              old_device_identity,
              new_device_identity,
              phone_number,
              otp_verified_at,
              rotation_receipt
            )
            VALUES ($1, $2, $3, NOW(), $4)
          `,
          [oldDeviceIdentity, newDeviceIdentity, auth.phone_number, rotationReceipt]
        );

        return {
          ok: true,
          old_device_identity: oldDeviceIdentity,
          new_device_identity: newDeviceIdentity,
          rotation_receipt: rotationReceipt
        };
      });

      return result;
    } catch (error) {
      return reply.code(error.statusCode || 500).send({
        error: error.message || "Identity rotation failed."
      });
    }
  });

  app.post("/identity/revoke", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const deviceIdentity = String(request.body?.device_identity || "").trim();
    if (!deviceIdentity) {
      return reply.code(400).send({ error: "device_identity is required." });
    }

    const deviceResult = await query(
      `
        SELECT device_identity, phone_number, revoked_at
        FROM device_identities
        WHERE device_identity = $1
        LIMIT 1
      `,
      [deviceIdentity]
    );

    const device = deviceResult.rows[0];
    if (!device || device.phone_number !== auth.phone_number) {
      return reply.code(404).send({ error: "Device not found for this account." });
    }

    await query(
      `
        UPDATE device_identities
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE device_identity = $1
      `,
      [deviceIdentity]
    );

    return { ok: true };
  });
}
