import { readdir } from "node:fs/promises";

export function parseMigrationVersion(filename) {
  const match = String(filename || "").match(/^(\d+)_.*\.sql$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function listMigrationFiles(dir) {
  const entries = await readdir(dir);
  return entries
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => ({
      filename,
      version: parseMigrationVersion(filename)
    }))
    .filter((entry) => Number.isInteger(entry.version))
    .sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));
}
