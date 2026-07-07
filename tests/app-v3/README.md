# app-v3 client test seed

Zero-dependency tests (Node built-in `node:test`) for the four pure ES modules
extracted from `app-v3/app.js` in Item #7 Phases 7A/7B:

- `nlp-parser.test.mjs` — natural transaction parsing incl. Phase 4A liability
  routing, quantity-only sale normalization, pidgin empty-label rule
- `label-scorer.test.mjs` — score tiers, the `CONFIDENT_LABEL_SCORE` threshold,
  action-key mappings
- `catalog-data.test.mjs` — structural invariants (locked action ids, sector /
  business-type / quick-pick referential integrity, liability labels global)
- `passcode-crypto.test.mjs` — KDF constants, hash determinism, hex round-trips

## Run

```sh
node --test tests/app-v3/*.test.mjs
```

Requires Node >= 22.7 (the app modules are extensionless-`.js` ES modules with
no package.json; older Node versions parse them as CommonJS). Tests live
outside `app-v3/` on purpose so they are never served as static assets.

These tests import production modules read-only and change no production file.
