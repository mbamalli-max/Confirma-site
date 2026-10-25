# Sign-out browser tests

These Playwright tests run the static `app-v3` site against the local API and a
dedicated local PostgreSQL database. They perform real onboarding and OTP
verification in the browser. The API is started with development OTP enabled;
the tests read the development code displayed by the app, never a fixed token.

From `tests/app/`, after the architect has run the permitted offline install:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
APP_TEST_URL=http://127.0.0.1:5500 \
APP_TEST_API_URL=http://127.0.0.1:8787 \
APP_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/confirma_signout_test \
npm test
```

Ports are 5500 for the static app and 8787 for the API. `APP_TEST_URL`,
`APP_TEST_API_URL`, and `APP_TEST_DATABASE_URL` must be local URLs. The database
name must contain `test`, `tmp`, or `throwaway`.

`global-setup.mjs` validates those guards, drops the named throwaway database,
creates it, and runs the server migration. `global-teardown.mjs` drops that same
database. Do not point this suite at a database containing data you need.

The tests receive a new browser context per case; IndexedDB begins empty for
each case but deliberately survives reloads and additional pages in that case.
Database inspection is read-only and queries `user_sessions` only to verify
that the local UI action produced the expected server session state.
