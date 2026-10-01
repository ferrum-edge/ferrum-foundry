# Ferrum Foundry

Admin UI for [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge), a high-performance API gateway built in Rust.

## Buildout policy

Ferrum Foundry is in active buildout and has no users yet. Breaking changes are
allowed. Do not add compatibility shims, deprecation periods, or upgrade paths
solely to preserve earlier development versions. Update code, tests, fixtures,
demo data, and documentation together, keeping Foundry aligned with the current
Ferrum Edge admin API.

Foundry has no application database, SQL schema, or migration runner. Ferrum
Edge owns the database; do not copy its schema, migration files, or database
implementation paths into this repository. If Foundry adds its own persistence
during buildout, keep one canonical initial schema and fold later changes into
it. Recreate disposable development data instead of building a migration
history. Revisit compatibility and migration requirements before onboarding
users.

## Architecture

- **Frontend**: React 19, TanStack Router, TanStack Query, Tailwind CSS v4, Radix UI
- **BFF server**: Fastify (`server/`). Proxies admin API requests to the Ferrum Edge gateway and handles JWT signing and TLS
- **Build**: Vite 8, TypeScript 6

The UI never calls the Ferrum Edge admin API directly. Every API call goes
through the BFF, which signs it with a JWT.

## OpenAPI Spec

**Do NOT store a local copy of `openapi.yaml` in this repo.** The canonical spec is
https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml.

Check types and form fields against the upstream spec. It changes regularly, so
a local copy would go stale.

Shared org contracts are vendored under `contracts/ferrum-contracts/`; see
[Contracts](README.md#contracts).

## Development

```bash
# Required env vars for the BFF server
export FERRUM_ADMIN_URL=http://127.0.0.1:9000
export FERRUM_JWT_SECRET=dev-secret-at-least-32-characters-long
export FERRUM_BFF_AUTH_TOKEN=dev-bff-token-at-least-32-characters-long
export FERRUM_JWT_NAMESPACES='*'  # static mode: exact names, or * for every namespace

# Start frontend + BFF. In the browser, paste FERRUM_BFF_AUTH_TOKEN once to
# exchange it for an HttpOnly session.
npm run dev

# Demo backends (ports 9101-9105). Bind all interfaces only when the
# gateway runs in Docker and must reach them through host.docker.internal.
FERRUM_DEMO_BACKEND_BIND=0.0.0.0 node scripts/demo-backend.mjs

# OR: a mock admin API on :9000 (no gateway needed). It serves sample data for
# every admin surface and implements ETag/If-Match on the four
# full-replacement resource families.
node scripts/mock-admin-gateway.mjs
# The same mock with a read-only admin API (MOCK_GATEWAY_MODE=file, dp or mesh)
MOCK_GATEWAY_MODE=file node scripts/mock-admin-gateway.mjs

# Seed demo data (needs a running Ferrum Edge gateway)
FERRUM_NAMESPACE=ferrum-foundry-demo \
FERRUM_DEMO_CONFIRM_TARGET='http://127.0.0.1:9000#ferrum-foundry-demo' \
FERRUM_DEMO_BACKEND_HOST=host.docker.internal \
node scripts/seed-demo-gateway.mjs

# Generate demo traffic
node scripts/demo-traffic-client.mjs mixed
```

### Running the gateway locally

Run the Ferrum Edge image CI pins, by digest, so local results match CI. It is
the published Ferrum Edge v0.9.10 release, which Foundry v0.4.0 pairs with.
`edge.image` in `docs/compatibility.json` is the single source: CI reads it
(`node scripts/supported-pairing.mjs edge-image`), and
`scripts/supported-pairing.test.mjs` fails if the starter, this command, or any
doc names a different Edge image. The Edge `latest` tag is not refreshed for
releases. Moving the pin is a re-qualification; see `docs/compatibility.md`.

```bash
docker run --rm -d --name ferrum-edge \
  --add-host host.docker.internal:host-gateway \
  -e FERRUM_MODE=database \
  -e FERRUM_DB_TYPE=sqlite \
  -e FERRUM_DB_URL="sqlite:////tmp/ferrum.db?mode=rwc" \
  -e FERRUM_NAMESPACE=ferrum-foundry-demo \
  -e FERRUM_ADMIN_JWT_SECRET=dev-secret-at-least-32-characters-long \
  -e FERRUM_BASIC_AUTH_HMAC_SECRET=dev-basic-hmac-secret-at-least-32-characters \
  -e FERRUM_ADMIN_BIND_ADDRESS=0.0.0.0 \
  -e FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true \
  -p 127.0.0.1:9000:9000 -p 127.0.0.1:8000:8000 \
  ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc run -m database -v
```

The plaintext admin bind above is a local-development exception; Docker's port
mapping limits it to host loopback. Anywhere else, use admin TLS and an
allowlist.

## Authentication

See `docs/authentication.md`.

- Production uses `FERRUM_AUTH_MODE=trusted-proxy`: an OIDC/OAuth2-capable proxy
  asserts a stable actor, Ferrum role, and exact namespace grants behind a
  shared proof header.
- Static-token mode is development-only. The login route exchanges
  `FERRUM_BFF_AUTH_TOKEN` for a bounded server-side session in an HttpOnly,
  SameSite cookie, plus CSRF protection.
- `FERRUM_JWT_NAMESPACES` scopes the static principal and is required in static
  mode: exact names, or `*` alone for every namespace. Unset, or set with no
  names, is a startup error, never "unrestricted".
- No reusable administrator credential is stored in browser storage.
- Auth runs in `onRequest`, before content parsing.
- The authenticated actor, role, and namespaces become the downstream JWT
  `sub`, `role`, and `ns` claims.

### Capabilities

The UI mirrors the authorization matrix client-side, so a surface the session
cannot write is shown read-only, with the reason, before anything is edited.
The BFF and Ferrum Edge remain the only enforcement points. See
`docs/capabilities.md`.

- `src/lib/capabilities.ts` maps role x gateway mode to per-surface verdicts.
  `CapabilityProvider` / `useCapabilities()` (`src/stores/capabilities.tsx`)
  derive them from the session role plus one `/health` snapshot, and
  `src/components/shared/CapabilityGate.tsx` renders them.
- A fact that was never read is `null` and concludes nothing, so a failed health
  read never downgrades a surface. The last snapshot that *did* load is kept for
  the provider's lifetime, because a gateway's mode and write policy only change
  on restart.
- Each surface names the upstream write gate it mirrors: `config-store`,
  `read-only-mode`, or `none`. They are not interchangeable. For example,
  managed TLS/ACME is refused in a read-only mode even though
  `admin_writes_enabled` does not describe it.
- A read-only surface never shows less than the editable one: collapsible
  sections are forced open and Cancel stays outside the disabled fieldset.
- `scripts/capability-parity-contract.mjs` checks the model against the pinned
  gateway as each role, both writable and with `FERRUM_ADMIN_READ_ONLY`. Extend
  its probe table when you add a surface.
- A read the gateway refuses with `403` is a denial, rendered by
  `ReadDeniedNotice` (`src/components/shared/ReadState.tsx`), never an empty
  collection or a missing feature.

## Theming

Dark and light themes via CSS custom properties. Dark is the default.

- **Design tokens**: `src/styles/globals.css`, as `:root` variables (dark) with `:root[data-theme="light"]` overrides
- **Theme state**: `src/stores/theme.tsx` (`ThemeProvider` + `useTheme`), persisted to `localStorage` under `ferrum:theme`
- **Toggle**: sun/moon button in the header (`src/components/layout/Header.tsx`)
- **Flash prevention**: `index.html` loads `public/theme-bootstrap.js` before the app, so the saved `data-theme` applies before first paint without weakening the production CSP
- All UI colors flow through CSS variables mapped via Tailwind v4's `@theme`; changing colors only needs `globals.css`

## Key directories

- `src/routes/` - page components (TanStack Router, lazy-loaded): the core CRUD
  pages plus `tls/` (inventory, managed stores, ACME, events, validate),
  `api-specs/` (spec import), `audit/`, `cluster/`, and `mesh/` (service graph,
  drift, egress, waypoints, trust)
- `src/components/forms/` - CRUD forms (`ProxyForm`, `ConsumerForm`, `PluginConfigForm`, `UpstreamForm`, etc.)
- `src/components/metrics/` - metrics dashboard panels (`OpsPanels.tsx` covers overload, runtime, and chargeback)
- `src/components/mcp/` - the proxy page's MCP Tools tab: the node-local
  `mcp_gateway` tool catalog (`src/api/mcpTools.ts`), inline per-tool policy
  edits (one `policy.tools` entry per guarded write, `src/lib/mcpToolPolicy.ts`),
  and the AI governance summary (`src/lib/mcpGovernance.ts`). See the v0.9.9
  section of `docs/compatibility.md`
- `src/api/` - API client, types, and endpoint modules (`tls.ts`, `mesh.ts`, `ops.ts`, `apiSpecs.ts`, `trust.ts` carry their own response types)
- `src/hooks/` - React Query hooks
- `src/lib/pluginConfigDefaults.ts` - plugin catalog: per-plugin default configs plus `PLUGIN_METADATA` (category + description) for the plugin picker
- `src/lib/pluginSchemas.ts` - reviewed field descriptors for the guided plugin
  editor (`key_auth`, `rate_limiting`, `cors`, `prometheus_metrics`),
  transcribed from named `openapi.yaml` schema components. See
  `docs/plugin-schemas.md`.
  - Foundry stores no copy of the spec, so each component's SHA-256 is pinned
    alongside the spec commit it was read at (`PLUGIN_SCHEMA_SPEC.ref`).
    `npm run check:plugin-schemas` (`scripts/plugin-schema-drift.mjs`) fetches
    the spec at that commit on every PR and compares the digests;
    `FERRUM_SPEC_REF=main` checks against the current upstream instead. Never
    update a digest or the ref without re-reading the schema.
  - Guided edits are lossless: unmodelled keys, key order, and omission/`null`
    semantics all survive. A shape the descriptors cannot model falls back to
    raw JSON with a stated reason rather than being rewritten.
- `server/` - Fastify BFF server
- `scripts/` - demo backend, seeding, traffic generation, `mock-admin-gateway.mjs`, the starter's `starter-preflight.mjs` / `starter-journey.mjs`, and the contract and drift checks
- `e2e/` - the critical-journey suite: a real browser against the production
  build, the starter's identity proxy, and the pinned gateway, ending with
  data-plane requests. `retries: 0` on purpose. Failures are *arranged* through
  `e2e/fault-proxy.mjs` (arm exactly N, assert they were consumed) rather than
  waited for, and `npm run e2e:gate-self-test` proves the gate fails when the
  journey is broken. See `e2e/README.md`
- `docs/compatibility.md` / `docs/compatibility.json` - the Foundry–Edge
  pairing: the Edge image CI qualifies (`edge.image`), the published Edge
  release the Foundry release pairs with (`edge.release`) and its requirements,
  rejected images, pin history, and the tested envelope.
  `docs/release-notes/vX.Y.Z.md` holds the notes for `foundry.version`, and
  `docs/release-notes/UNRELEASED.md` drafts the next. The release workflow
  requires `docs/release-notes/vX.Y.Z.md`, a `foundry.version` and
  `package.json` version matching the tag, and a passing
  `supported-pairing.mjs release-ready`
- `deploy/starter/` - the runnable deployment starter: one Compose stack with a
  `production` and a disposable `demo` profile. `nginx/identity/policy.conf`
  (group → role/namespace) and `nginx/identity/inject.conf` (the four identity
  headers) are included by **both** proxy configurations, so the demo exercises
  the production authorization path; a test fails if either config grows its
  own copy. See `docs/getting-started.md`

## Type conventions

- `src/api/types.ts` mirrors the Ferrum Edge admin API response shapes, NOT the OpenAPI schemas directly. Field names must match what the API actually returns
- Form components submit `*Create` types
- Proxies use `backend_scheme` (`http`/`https`/`tcp`/`tcps`/`udp`/`dtls`). gRPC and WebSocket are detected per request and are NOT schemes. Proxies have no `backend_protocol` field
- HTTP proxies need `hosts` and/or `listen_path`; stream proxies must omit `listen_path` and set `listen_port`. `allow_path_parameters` opts an HTTP proxy into RFC 3986 semicolon path parameters
- Consumer credentials are maps of rotation ARRAYS per type (`keyauth`, `basicauth`, `jwt`, `hmac_auth`, `mtls_auth`). Ordinary consumer responses redact secrets as the literal `[REDACTED]`; consumer writes preserve hidden credentials and use dedicated rotation endpoints
- Proxy PUT is full-replace: build update payloads with `proxies.toUpdatePayload(proxy)` and override fields. Never send partial bodies
- Health check enablement is controlled by presence/absence, not an `enabled` field
- `ServiceDiscoveryConfig` uses nested provider-specific objects (`dns_sd`, `kubernetes`, `consul`, `mesh`)

### Concurrent edits (write guard)

See `docs/concurrent-edits.md`.

- A full-replacement save from a detail editor carries a **write guard**. The
  editor captures a baseline when it is seeded (`src/lib/resourceBaseline.ts`).
  The API layer re-reads and compares it just before the PUT; a mismatch throws
  `StaleResourceError` and sends nothing (`src/api/conditionalWrite.ts`).
- On a match, the PUT carries `If-Match` set to the `ETag` of **that
  verification read** — never a tag from the editor's seed or a refetch — so
  Edge refuses it with `412` if anything commits in between. The guard then
  re-verifies, and re-sends only if the fields this write replaces are still
  unchanged.
- A read with no strong `ETag` (the cached-config fallback; every item read from
  the paired Edge release carries one) gets an unconditional PUT. That narrows
  the race to one round trip; it does not close it.
- Send `If-Match` only on `PUT`/`DELETE` of the four resource item paths
  (proxies, upstreams, consumers, plugin configs), and only a strong tag from a
  read. Anywhere else, or a malformed or empty value, is a `400`.
- `update()` and `remove()` on proxies, upstreams, and consumers take the guard
  as a required argument. Pass `null` only from a caller that provably cannot
  lose a concurrent change.
- Plugin configurations are written by the membership plan. It takes the
  editor's guard and makes each of its own read-compare-write steps conditional
  by passing the read it compared as `basis` (`validatorOf`). Never pass an
  editor seed or Query-cache value there.
- Detail-page deletes are guarded against the resource the page is displaying.
- A refused save keeps the draft; a refused delete deletes nothing. Both show a
  redacted original/current(/proposed) comparison (redaction applies at every
  depth of structured values such as plugin `config`). Nothing is resent
  automatically with the same body.
- A field a save omits and Edge preserves (`plugins` on a proxy, `labels` on a
  consumer or plugin configuration) is left out of the comparison, since the
  save cannot revert it.
- **Committed, not live.** A `503` with `X-Ferrum-Config-Cursor` or
  `applied: false` on a configuration write is a committed write, not a
  failure. `committedNotLiveAnswer()` (`src/api/gatewayMetadata.ts`) is the one
  predicate. The client marks it (`getCommittedWrite()`, following `cause`),
  shows no error popup (the live-apply banner reports it), and the
  `MutationCache` refreshes cached reads.
  - An editor that gets one reseeds its form **and** baseline from one fresh
    read (`reseedAfterCommit`). Never adopt the draft payload, or a read while
    keeping the form's fields.
  - A committed delete resolves as a delete (`removeCommitted`) so its detail
    cache is retired.

### Secret redaction

See `docs/concurrent-edits.md`.

- A write whose body carries a secret runs inside
  `withRedactedFailure(secretValues(body), …)` (`src/api/secretRedaction.ts`).
  That covers consumer create and credential writes, plugin configurations,
  upstreams, TLS key material and ACME account credentials, batch create,
  backup restore (`restoreSecrets`), and API spec import/replace
  (`specDocumentSecrets`). **Add any new secret-bearing write to it.**
- Its failure becomes a `RedactedWriteError`: every submitted secret is replaced
  by `[REDACTED]` in the message and parsed body (before any trim or
  truncation), with a bodiless response for the status and no `request`,
  `options`, or `cause`. It keeps the original error's `name` for the outcome
  classifiers. Redaction replaces every match found in the original text in one
  pass.
- The request carries `REDACT_ERRORS` (`src/api/client.ts`), which holds the
  global popup's report until the wrapper raises it redacted — same status,
  URL, and outcome, so a lost answer still opens "Outcome unknown". Use
  `SILENT_ERRORS` instead when the form reports every failure itself. Never
  neither: the popup would show the raw body.
- A plugin `config` is classified by Ferrum Edge's own projection table:
  `PLUGIN_SENSITIVITY` in `src/api/pluginSensitivity.ts`, transcribed from
  `plugin_config_projection.rs` at `edge.source_commit`.
  `scripts/plugin-sensitivity-drift.mjs` diffs it against that source in the
  Pinned Gateway Contract job, and its test fails when
  `PLUGIN_SENSITIVITY_SOURCE.commit` is not the pinned commit.
- A plugin the table does not name is secret throughout, as is every scalar of
  a YAML spec document Foundry cannot parse. Such an *unclassified* value
  shorter than 8 characters is redacted only as a whole token of a string, so
  `a`, `on`, or `error` cannot wipe out a `[REDACTED]` marker.
- No value shorter than 8 characters, classified or not, is matched in an object
  key or in the fixed-vocabulary fields callers rely on (`code`, `phase`,
  `rollback`, `failure_class`, `confirmation_required`), so a short credential
  cannot hide a restore's confirmation or recovery details.
- Secret-bearing mutation hooks set `gcTime: 0`.

### Errors and list reads

- ky v2 parses a failing response body into `error.data` **and consumes the
  response doing it**. From then on `error.response.clone()` throws "body is
  already used", synchronously, so it escapes a trailing `.catch()`. Read error
  bodies with `getApiErrorDetail()` / `extractApiErrorData()`, never by cloning
  the response.
- Admin API list endpoints accept **`offset` and `limit` only** — no search,
  filter, or reference query — with one exception: `GET /plugins/config?proxy_id=`
  (Edge v0.9.7+) lists the proxy-scoped configurations targeting one proxy.
  `plugins.listConfigsForProxy()` uses it and refuses a response the filter did
  not narrow. It cannot answer effective policy, which also needs global and
  proxy-group configurations. See `docs/data-loading.md`.
- Keep ordinary navigation bounded: a list page fetches one page, references
  are resolved for the rows on screen (`useUpstreamReferences`), and expensive
  secondary views load when their tab opens. A *summary* that would need a
  whole-collection scan stops at `SUMMARY_SCAN_BUDGET` and reports unavailable
  rather than a smaller number.
- A conclusion that is wrong if partial (effective policy, membership) is
  complete or unknown, never partial. Traversals take the Query's `AbortSignal`
  so a namespace switch abandons them; membership plans deliberately pass none.
- Mode-dependent observability endpoints (mesh, waypoints, charges, gateway
  trust, backend capabilities, audit, API specs) legitimately return 404/503 on
  gateways without the feature. The ky client suppresses the global error popup
  for them (`SILENT_PROBE_PATTERNS` in `src/api/client.ts`) and pages render
  empty states.

## Namespaces

Namespaces are a full CRUD registry on the gateway, not just a header value.
`src/api/namespaces.ts` covers `GET/POST /namespaces` and
`GET/PUT/DELETE /namespaces/{name}`; the Settings page manages them through
`src/components/forms/NamespaceManagerCard.tsx`.

### Scoping requests

- **Every namespace-scoped API function takes a `NamespaceScope` as its first
  argument** (`src/api/client.ts`) and builds its ky options with
  `scoped(scope, …)`, which stamps `X-Ferrum-Namespace`. Hooks read `scope` from
  `useNamespace()` once per operation and pass it to every request the
  operation makes: all `listAll()` pages, membership preflight/apply/rollback
  via `bindPluginMembership(scope)`, restore, and the apply-status poll.
- The client never reads the namespace from storage. A gateway request with no
  binding that is not `FLEET_GLOBAL` is refused with `UnboundNamespaceError`.
- `NamespaceProvider` (`src/stores/namespace.tsx`) owns the active namespace per
  tab. `localStorage` is only a load-time preference: read once at mount and
  written on switch. Cross-tab `storage` events are deliberately ignored, so
  another tab's switch can never retarget a running operation. See
  `docs/authentication.md` → "Namespace binding".
- TLS inventory, managed TLS material, ACME, rotation, and validation are
  fleet-global upstream surfaces. They use the `FLEET_GLOBAL` client context so
  Foundry does not imply that `X-Ferrum-Namespace` scopes them. Keep the UI
  warning and destructive confirmation wording explicit.

### Registry API

- `GET /namespaces` returns a paginated envelope of plain **name strings**, not
  records. It is the union of the durable registry and namespaces derived from
  resource rows, so a listed name may have no registry row behind it.
- `GET /namespaces/{name}` synthesizes a record for such derived-only names. Its
  `created_at`/`updated_at` are **observation timestamps stamped per request**:
  never compare them, cache them as identity, or sort by them.
- Names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (max 254).
  `validateNamespaceName()` mirrors this client-side so bad input never reaches
  the gateway.
- PUT is a partial update, unlike proxy PUT: omit a field to keep it.
  `name: null` is a `400` (omit it instead); `description: null` or `""` clears
  the description. Build payloads with `buildNamespaceUpdate()`, not by hand.
- DELETE needs `?confirm=true` to cascade-delete a non-empty namespace; without
  it a non-empty namespace is a `409`.
- The gateway's own configured namespaces (`FERRUM_NAMESPACE`,
  `FERRUM_CP_NAMESPACES`) and the last remaining registry row cannot be renamed
  or deleted; expect `409`.

### Rename and delete

- After a rename or delete, **remove** the retired `["namespace", name]` query
  key rather than invalidating it (`reconcileNamespaceCache` in
  `src/hooks/useNamespaces.ts`). Invalidating refetches a name the gateway no
  longer resolves and pops a spurious 404 over a successful mutation. Every
  other query scoped under the retired name (`[kind, name, …]`) is removed too,
  so a recreated namespace never seeds an editor from a resource the cascade
  destroyed.
- Delete is a two-stage, gateway-driven flow (`DeleteNamespaceDialog`), not a
  cascade checkbox. Stage 1 always sends the **unconfirmed** DELETE, so an empty
  namespace goes in one click. The gateway's `409` ("not empty") promotes stage
  2, which shows real occupancy counts and gates the cascade behind typing the
  namespace name. This is the only type-to-confirm in the app, because it is
  the highest-blast-radius action.
- Only an occupancy `409` is cascadable. Protected-namespace and
  last-registry-row `409`s are terminal: `isCascadableDeleteError()` filters
  them out so the UI never offers a cascade that would fail again.
- `namespaces.remove()` opts out of the global error popup with
  `context: { [SILENT_ERRORS]: true }` (`src/api/client.ts`), because its `409`
  is an expected answer, not a fault. Use the same opt-out for any call whose
  failure the caller handles itself.

### Editor identity

See `docs/authentication.md` → "Editor identity".

- Detail-page editors are bound to `{ namespace, resourceId }`
  (`src/lib/editorIdentity.ts`, `useEditorIdentity` in
  `src/hooks/useEditorIdentity.ts`). The route component owns the session and
  renders `<Editor key={session.key} session={session} />`. A namespace switch
  or route change therefore remounts the form, credential drafts, inline target
  editors, and confirmation dialogs against the new resource, instead of
  carrying the previous tenant's fields across a cached switch.
- Wrap submit/confirm handlers in `session.bind()` (call `preventDefault()`
  outside it) so a call that outlives its editor is discarded.
- Forms seed their state once per identity and never rewrite fields on a
  background refetch of the same identity. Do not put `updated_at` or other
  per-response values in the key.
- Because forms seed once, a mutation must **retire** (`removeQueries`) the
  scoped detail key of every resource it deleted or re-created, not merely
  invalidate it. Mutations whose gateway effect cascades across resource types
  (spec import/replace/delete, proxy delete, namespace restore) do this through
  `retireCascade()` in `src/hooks/retireCascade.ts`, by namespace prefix, using
  the namespace the mutation was issued under.

## Build & check

```bash
npm run typecheck    # TypeScript: frontend, server, and e2e
npm run build        # Production build (Vite + server tsc)
npm run lint         # ESLint
npm test             # Vitest, then the node --test contract suites in scripts/
```
