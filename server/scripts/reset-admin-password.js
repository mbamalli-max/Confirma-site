import process from "node:process";
import readline from "node:readline/promises";
import * as database from "../src/db.js";
import { config } from "../src/config.js";
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  hashAdminPassword,
  validateAdminPassword
} from "../src/admin-auth-utils.js";
import { resetAdminPassword } from "../src/admin-password.js";

async function promptHidden(prompt) {
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
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password reset requires an interactive terminal.");
  }
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = String(await prompt.question("Admin email: ")).trim().toLowerCase();
  prompt.close();
  if (!isValidEmail(email)) throw new Error("Enter a valid admin email address.");

  const password = await promptHidden("New admin password: ");
  const confirmation = await promptHidden("Confirm new admin password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (!validateAdminPassword(password)) {
    throw new Error(`Password must be ${ADMIN_PASSWORD_MIN_LENGTH} to ${ADMIN_PASSWORD_MAX_LENGTH} characters and not blank.`);
  }

  const passwordHash = await hashAdminPassword(password);
  const adminUser = await resetAdminPassword(database, { email, passwordHash, reason: "operator_script" });
  process.stdout.write(`Password reset for ${adminUser.email}. All sessions for this admin were ended.\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (config.databaseUrl) await database.getPool().end().catch(() => {});
  });
