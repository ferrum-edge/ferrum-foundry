---
paths:
  - "server/**"
  - "src/api/**"
  - "src/stores/**"
  - "scripts/mock-admin-gateway.mjs"
  - "scripts/seed-demo-gateway.mjs"
  - "docs/authentication.md"
  - "docs/deployment.md"
---

# Foundry Configuration And Storage Rules

## Compatibility

- From 1.0.0 onward the [compatibility policy](../../README.md#compatibility-policy)
  applies: documented `FERRUM_*` variables, the trusted-proxy identity
  contract and the BFF health endpoints are stable across 1.x and change
  incompatibly only through the documented deprecation. Update affected code,
  tests, fixtures, demo data, and docs together.

## Database Ownership

- Foundry has no application database, SQL schema, migration runner, or data
  files. It has no durable state of its own.
- Ferrum Edge owns gateway persistence. Foundry accesses gateway resources
  through the admin API via the Fastify BFF, never through a database connection.
- Database initialization, schema changes, and custom-plugin storage belong in
  the [Ferrum Edge repository](https://github.com/ferrum-edge/ferrum-edge).
  Do not copy gateway database files or document its implementation paths as
  local Foundry paths.
- Adding durable state to Foundry is a compatibility decision: it needs a
  frozen baseline schema, forward-only migrations, and a test that state
  written by the previous release opens after an upgrade. Never "recreate it"
  after 1.0.0.

## Current State

- `server/config.ts` reads startup configuration from the environment. Runtime
  settings (`PUT /api/settings` in `server/routes/settings.ts`, off unless
  `FERRUM_ALLOW_RUNTIME_SETTINGS=true`) are held as in-memory overrides in
  `server/config.ts` and are lost on restart; they do not write a settings
  database or file.
- Development static-auth sessions in `server/auth.ts` live in a process-local
  map. Trusted-proxy mode relies on the identity asserted by the reverse proxy.
- Browser preferences (`ferrum:theme`, `ferrum:namespace`,
  `ferrum:metricsRefreshInterval`, `ferrum:metricsRequestSample:<namespace>` in
  `localStorage`; `ferrum:metricsPlaceholderSeenAt` in `sessionStorage`) are not
  gateway data. Validate every read and fall back to the default, so a release
  may rename or drop one without an upgrade step. Preserve per-tab namespace
  binding and never store reusable administrator credentials in browser storage.
- `scripts/mock-admin-gateway.mjs` uses in-memory fixtures. The demo seed script
  writes gateway resources through the admin API; it is not a schema initializer.

## API Contracts

- Keep `src/api/` types and forms aligned with actual gateway responses and
  submission contracts. Consult the canonical upstream OpenAPI spec described
  in [CLAUDE.md](../../CLAUDE.md#openapi-spec); do not save a local copy.
- Carry `NamespaceScope` through namespace-scoped operations and use
  `FLEET_GLOBAL` for fleet-global surfaces. Follow the namespace and editor
  identity rules in [CLAUDE.md](../../CLAUDE.md#namespaces).
