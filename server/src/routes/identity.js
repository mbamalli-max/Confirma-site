import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { query, withTransaction } from "../db.js";

export async function registerIdentityRoutes(app) {
  app.post("/identity/rotate", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const oldDeviceIdentity = String(request.body?.old_device_identity || "").trim();
    const newDeviceIdentity = String(request.body?.new_device_identity || "").trim();
    const newPublicKey = String(request.body?.new_public_key || "").trim();

    if (!oldDeviceIdentity || !newDeviceIdentity || !newPublicKey) {
      return reply.code(400).send({ error: "old_device_identity, new_device_identity, and new_public_key are required." });
    }

    try {
      const result = await withTransaction(async (client) => {
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
      return reply.code(500).send({
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

 