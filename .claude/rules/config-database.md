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

## Buildout

- Foundry is in active buildout with no users. Breaking changes are allowed;
  update affected code, tests, fixtures, demo data, and docs together.
- Do not add compatibility layers or incremental migrations solely to preserve
  earlier development versions. Revisit this policy before onboarding users.

## Database Ownership

- Foundry has no application database, SQL schema, or migration runner.
- Ferrum Edge owns gateway persistence. Foundry accesses gateway resources
  through the admin API via the Fastify BFF, never through a database connection.
- Database initialization, schema changes, and custom-plugin storage belong in
  the [Ferrum Edge repository](https://github.com/ferrum-edge/ferrum-edge).
  Do not copy gateway database files or document its implementation paths as
  local Foundry paths.
- If Foundry adds its own persistence during buildout, keep one canonical
  initial schema and fold subsequent schema changes into it. Recreate
  disposable development data instead of preserving a migration chain.

## Current State

- `server/config.ts` reads startup configuration from the environment. Runtime
  settings in `server/routes/settings.ts` update process memory and are lost on
  restart; they do not write a settings database or file.
- Development static-auth sessions in `server/auth.ts` live in a process-local
  map. Trusted-proxy mode relies on the identity asserted by the reverse proxy.
- Browser theme and namespace preferences live in `src/stores/`; they are not
  gateway data. Preserve per-tab namespace binding and never store reusable
  administrator credentials in browser storage.
- `scripts/mock-admin-gateway.mjs` uses in-memory fixtures. The demo seed script
  writes gateway resources through the admin API; it is not a schema initializer.

## API Contracts

- Keep `src/api/` types and forms aligned with actual gateway responses and
  submission contracts. Consult the canonical upstream OpenAPI spec described
  in [CLAUDE.md](../../CLAUDE.md#openapi-spec); do not save a local copy.
- Carry `NamespaceScope` through namespace-scoped operations and use
  `FLEET_GLOBAL` for fleet-global surfaces. Follow the namespace and editor
  identity rules in [CLAUDE.md](../../CLAUDE.md#namespaces).
