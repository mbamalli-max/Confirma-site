import process from "node:process";
import readline from "node:readline/promises";
import QRCode from "qrcode";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import {
  encryptTotpSecret,
  generateTotpSecret,
  hashAdminPassword
} from "../src/admin-auth-utils.js";

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password entry requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };

    const onData = (input) => {
      for (const character of input) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

async function main() {
  const force = process.argv.includes("--force");
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!/^[0-9a-fA-F]{64}$/.test(String(config.adminTotpEncKey || ""))) {
    throw new Error("ADMIN_TOTP_ENC_KEY must be exactly 64 hexadecimal characters.");
  }

  const existing = await query(`SELECT COUNT(*)::int AS count FROM admin_users WHERE status = 'ACTIVE'`);
  if (existing.rows[0].count > 0 && !force) {
    throw new Error("An ACTIVE admin already exists. Re-run with --force only when intentionally adding another admin.");
  }

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = String(await prompt.question("Admin email: ")).trim().toLowerCase();
  prompt.close();
  if (!isValidEmail(email)) throw new Error("Enter a valid admin email address.");

  const password = await promptHidden("Admin password: ");
  if (!password) throw new Error("Admin password is required.");

  const passwordHash = await hashAdminPassword(password);
  const totpSecret = generateTotpSecret();
  const totpSecretEnc = encryptTotpSecret(totpSecret);
  const issuer = "Konfirmata Admin";
  const label = `${issuer}:${email}`;
  const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${totpSecret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

  await query(
    `
      INSERT INTO admin_users (email, password_hash, totp_secret_enc, role)
      VALUES ($1, $2, $3, 'owner')
    `,
    [email, passwordHash, totpSecretEnc]
  );

  process.stdout.write("Admin owner created. Enrol TOTP now and store the recovery material securely.\n");
  process.stdout.write(`${otpauthUri}\n`);
  process.stdout.write(await QRCode.toString(otpauthUri, { type: "terminal", small: true }));
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (config.databaseUrl) {
      await getPool().end().catch(() => {});
    }
  });
