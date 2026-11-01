import { withTransaction } from "./db.js";
import { writeAuditRow } from "./admin-auth-utils.js";

const RESET_REFUSED_MESSAGE = "Admin password reset could not be completed.";

export async function resetAdminPassword(database, { email, passwordHash, reason = "operator_script" }) {
  const runTransaction = database?.withTransaction || withTransaction;
  const normalizedEmail = String(email || "").trim().toLowerCase();

  return runTransaction(async (client) => {
    // Lock the admin before touching its sessions. Login uses this same order.
    const result = await client.query(
      `
        SELECT id, email, status
        FROM admin_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedEmail]
    );
    const adminUser = result.rows[0] || null;
    if (!adminUser || adminUser.status !== "ACTIVE") {
      throw new Error(RESET_REFUSED_MESSAGE);
    }

    await client.query(
      `
        UPDATE admin_users
        SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = NOW()
        WHERE id = $1
      `,
      [adminUser.id, passwordHash]
    );
    await client.query(
      `
        UPDATE admin_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE admin_user_id = $1
      `,
      [adminUser.id]
    );
    await writeAuditRow({
      action: "admin.password.reset",
      subjectType: "admin_user",
      subjectId: adminUser.id,
      reason
    }, client);

    return { id: adminUser.id, email: adminUser.email };
  });
}
