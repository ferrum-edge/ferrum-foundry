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

# Start frontend + BFF
npm run dev

# Start demo backends (ports 9101-9105)
node scripts/demo-backend.mjs

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

## Theming

The app supports dark and light themes via CSS custom properties. Dark is the default.

- **Design tokens** are defined in `src/styles/globals.css` as `:root` variables (dark) with `:root[data-theme="light"]` overrides
- **Theme state** lives in `src/stores/theme.tsx` (`ThemeProvider` + `useTheme` hook), persisted to `localStorage` under `ferrum:theme`
- **Toggle** is in the header (`src/components/layout/Header.tsx`) — sun/moon icon button
- **Flash prevention**: `index.html` has an inline script that applies the persisted `data-theme` attribute before first paint
- All UI colors flow through CSS variables mapped via Tailwind v4's `@theme` — adding or changing colors only requires editing `globals.css`

## Key directories

- `src/routes/` - Page components (TanStack Router, lazy-loaded)
- `src/components/forms/` - CRUD form components (ProxyForm, ConsumerForm, PluginConfigForm, UpstreamForm, etc.)
- `src/components/metrics/` - Metrics dashboard panels
- `src/api/` - API client, types, and endpoint modules
- `src/hooks/` - React Query hooks for data fetching
- `server/` - Fastify BFF server
- `scripts/` - Demo backend, seeding, and traffic generation

## Type conventions

- `src/api/types.ts` mirrors the Ferrum Edge admin API response shapes (NOT the OpenAPI spec schemas directly -- field names must match what the API actually returns)
- Form components use `*Create` types for submission payloads
- Health check enablement is controlled by presence/absence (not an `enabled` boolean field)
- `ServiceDiscoveryConfig` uses nested provider-specific objects (`dns_sd`, `kubernetes`, `consul`)

## Build & check

```bash
npm run typecheck    # Full TypeScript validation (frontend + server)
npm run build        # Production build (Vite + server TSC)
npm run lint         # ESLint
```
