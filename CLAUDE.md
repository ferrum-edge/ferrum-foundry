# Ferrum Foundry

Admin UI dashboard for [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge), a high-performance API gateway built in Rust.

## Architecture

- **Frontend**: React 19 + TanStack Router + TanStack Query + Tailwind CSS + Radix UI
- **BFF Server**: Fastify server (`server/`) that proxies admin API requests to the Ferrum Edge gateway, handling JWT signing and TLS
- **Build**: Vite 8 + TypeScript 6

The UI does NOT talk directly to the Ferrum Edge admin API. All API calls go through the BFF server which signs requests with JWT.

## OpenAPI Spec

**Do NOT store a local copy of `openapi.yaml` in this repo.** The canonical OpenAPI spec lives at:
https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml

Always reference the upstream spec when validating types or form fields. The spec changes regularly and a local copy will go stale.

## Development

```bash
# Required env vars for the BFF server
export FERRUM_ADMIN_URL=http://127.0.0.1:9000
export FERRUM_JWT_SECRET=dev-secret
export FERRUM_BFF_AUTH_TOKEN=dev-bff-token-please-make-this-long-and-random

# Start frontend + BFF
npm run dev

# In the browser, paste FERRUM_BFF_AUTH_TOKEN into the login screen on first load.

# Start demo backends (ports 9101-9105)
node scripts/demo-backend.mjs

# OR: run against a mock admin API (no gateway needed; serves sample data
# for every admin surface including TLS, ACME, audit, mesh, chargeback)
node scripts/mock-admin-gateway.mjs   # listens on :9000

# Seed demo data (needs running Ferrum Edge gateway)
node scripts/seed-demo-gateway.mjs

# Generate demo traffic
node scripts/demo-traffic-client.mjs mixed
```

### Running the gateway locally

```bash
docker run --rm -d --name ferrum-edge \
  -e FERRUM_MODE=database \
  -e FERRUM_DB_TYPE=sqlite \
  -e FERRUM_DB_URL="sqlite:///tmp/ferrum.db?mode=rwc" \
  -e FERRUM_ADMIN_JWT_SECRET=dev-secret \
  -p 9000:9000 -p 8000:8000 \
  ferrumedge/ferrum-edge:latest run -m database -v
```

## Authentication

The BFF requires `FERRUM_BFF_AUTH_TOKEN` and gates all privileged endpoints
(`/api/proxy/*`, `/api/settings`, `/api/settings/status`) with a bearer-token
preHandler (`server/auth.ts`). The frontend `AuthProvider` (`src/stores/auth.tsx`)
holds the token in `localStorage` under `ferrum:bff-auth-token`; the ky client
attaches it as `Authorization: Bearer <token>` on every request and clears it
on a 401. The `LoginGate` (`src/components/auth/LoginGate.tsx`) wraps the
router and prompts for the token whenever none is stored. `GET /api/settings`
returns the JWT secret as a sentinel (`'********'`); the server ignores PUTs
that echo that sentinel back.

## Theming

The app supports dark and light themes via CSS custom properties. Dark is the default.

- **Design tokens** are defined in `src/styles/globals.css` as `:root` variables (dark) with `:root[data-theme="light"]` overrides
- **Theme state** lives in `src/stores/theme.tsx` (`ThemeProvider` + `useTheme` hook), persisted to `localStorage` under `ferrum:theme`
- **Toggle** is in the header (`src/components/layout/Header.tsx`) — sun/moon icon button
- **Flash prevention**: `index.html` has an inline script that applies the persisted `data-theme` attribute before first paint
- All UI colors flow through CSS variables mapped via Tailwind v4's `@theme` — adding or changing colors only requires editing `globals.css`

## Key directories

- `src/routes/` - Page components (TanStack Router, lazy-loaded). Includes
  `tls/` (inventory, managed stores, ACME, events, validate), `api-specs/`
  (spec import), `audit/`, `cluster/`, and `mesh/` (service graph, drift,
  egress, waypoints, trust) alongside the core CRUD pages
- `src/components/forms/` - CRUD form components (ProxyForm, ConsumerForm, PluginConfigForm, UpstreamForm, etc.)
- `src/components/metrics/` - Metrics dashboard panels (incl. `OpsPanels.tsx` for overload/runtime/chargeback)
- `src/api/` - API client, types, and endpoint modules (`tls.ts`, `mesh.ts`, `ops.ts`, `apiSpecs.ts`, `trust.ts` bundle their own response types)
- `src/hooks/` - React Query hooks for data fetching
- `src/lib/pluginConfigDefaults.ts` - plugin catalog: per-plugin default configs plus `PLUGIN_METADATA` (category + description) used by the plugin picker
- `server/` - Fastify BFF server
- `scripts/` - Demo backend, seeding, traffic generation, and `mock-admin-gateway.mjs`

## Type conventions

- `src/api/types.ts` mirrors the Ferrum Edge admin API response shapes (NOT the OpenAPI spec schemas directly -- field names must match what the API actually returns)
- Form components use `*Create` types for submission payloads
- Proxies use `backend_scheme` (`http`/`https`/`tcp`/`tcps`/`udp`/`dtls`); gRPC and WebSocket are detected per-request and are NOT schemes. The legacy `backend_protocol` enum is gone
- HTTP proxies need `hosts` and/or `listen_path`; stream proxies must omit `listen_path` and set `listen_port`
- Consumer credentials are maps of rotation ARRAYS per type (`keyauth`, `basicauth`, `jwt`, `hmac_auth`, `mtls_auth`); ordinary responses redact secrets as the literal `[REDACTED]`, which PUT accepts as a round-trip marker
- Proxy PUT is full-replace: build update payloads with `proxies.toUpdatePayload(proxy)` and override fields, never send partial bodies
- Health check enablement is controlled by presence/absence (not an `enabled` boolean field)
- `ServiceDiscoveryConfig` uses nested provider-specific objects (`dns_sd`, `kubernetes`, `consul`, `mesh`)
- Mode-dependent observability endpoints (mesh/*, waypoints, charges, trust, audit, api-specs) legitimately 404/503 on gateways without the feature; the ky client suppresses the global error popup for them (see `SILENT_PROBE_PATTERNS` in `src/api/client.ts`) and pages render empty states

## Namespaces

Namespaces are a full CRUD registry on the gateway, not just a header value.
`src/api/namespaces.ts` covers `GET/POST /namespaces` and
`GET/PUT/DELETE /namespaces/{name}`; the Settings page manages them via
`src/components/forms/NamespaceManagerCard.tsx`.

- `GET /namespaces` returns a paginated envelope of plain **name strings**, not records. It is the union of the durable registry and namespaces derived from resource rows, so a name can appear in the list with no registry row behind it
- `GET /namespaces/{name}` synthesizes a record for such derived-only names. Its `created_at`/`updated_at` are **observation timestamps stamped per request** — never compare them, cache them as identity, or sort by them
- Names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (max 254). `validateNamespaceName()` mirrors this client-side so bad input never reaches the gateway
- PUT is a partial update, unlike proxy PUT: omit a field to keep it. `name: null` is a `400` (omit instead); `description: null` or `""` clears the description. Build payloads with `buildNamespaceUpdate()` rather than by hand
- DELETE needs `?confirm=true` to cascade-delete a non-empty namespace; without it a non-empty namespace is a `409`
- The gateway's own configured namespaces (`FERRUM_NAMESPACE`, `FERRUM_CP_NAMESPACES`) and the last remaining registry row cannot be renamed or deleted — expect `409`
- After a rename or delete, **remove** the retired `["namespace", name]` query key rather than invalidating it (`reconcileNamespaceCache` in `src/hooks/useNamespaces.ts`). Invalidating refetches a name the gateway no longer resolves and pops a spurious 404 on top of a successful mutation

## Build & check

```bash
npm run typecheck    # Full TypeScript validation (frontend + server)
npm run build        # Production build (Vite + server TSC)
npm run lint         # ESLint
```
