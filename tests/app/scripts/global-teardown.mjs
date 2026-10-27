import { assertLocalDatabaseUrl, dropDatabaseWithRetry } from "./local-only.mjs";

export default async function globalTeardown() {
  // Deliberately validate again before dropping the throwaway database. This
  // script never permits a non-local target.
  const database = assertLocalDatabaseUrl(process.env.APP_TEST_DATABASE_URL);
  await dropDatabaseWithRetry(database);
}
