<p align="center">
  <img src="docs/ferrum_foundry.png" alt="Ferrum Foundry" width="300" />
</p>

<h1 align="center">Ferrum Foundry</h1>

<p align="center">
  <a href="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/ci.yml"><img src="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/release.yml"><img src="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="https://github.com/ferrum-edge/ferrum-foundry/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-22.22.2%2B%20%7C%2024.15%2B%20%7C%2026%2B-brightgreen" alt="Node.js 22.22.2+, 24.15.0+, or 26+ (image: 24 LTS)" />
  <img src="https://img.shields.io/badge/TypeScript-6-blue" alt="TypeScript" />
</p>

Admin panel UI for managing and observing the [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge) Proxy/Gateway.

## Screenshots

Captured against the bundled mock admin gateway
(`node scripts/mock-admin-gateway.mjs`) in the dark theme. Every surface below
works the same way against a live Ferrum Edge gateway.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Ferrum Foundry dashboard with connection status, gateway health and resource counts" width="100%" />
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/metrics.png" alt="Metrics dashboard with gateway stats, overload protection and host runtime" />
      <sub><b>Metrics</b> — gateway stats, status codes, overload protection and host runtime, one refresh policy across every panel.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/plugins.png" alt="Plugin configuration list with scope, priority and execution triggers" />
      <sub><b>Plugins</b> — category-grouped catalog of gateway plugins with scope, priority, execution triggers and enable/disable.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/tls.png" alt="TLS management inventory with rotation controls" />
      <sub><b>TLS</b> — fleet-global inventory, managed certificate stores, ACME automation, rotation and PEM validation.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/audit.png" alt="Audit log of Admin API mutations with actor and outcome" />
      <sub><b>Audit log</b> — recorded Admin API mutations with collection and delivery status, filterable by action and resource.</sub>
    </td>
  </tr>
</table>

## Supported Ferrum Edge version

The current candidate pairing is **Foundry v0.5.7 / Ferrum Edge v0.9.21**
(#728), pinned by digest in `docs/compatibility.json`; hosted qualification and
Foundry publication are pending. The latest published pairing remains
**Foundry v0.5.6 / Ferrum Edge v0.9.20** (#686), whose source, image, platform
digests, qualification and publication evidence are preserved in the
[immutable v0.5.6 record](docs/release-notes/v0.5.6.compatibility.json).
Earlier pairings remain unchanged in the
[pairing record](docs/compatibility.md#history).

The qualification envelope stays `database` mode on SQLite (writable and
`FERRUM_ADMIN_READ_ONLY`), the trusted-proxy starter, Chromium, and
`linux/amd64` and `linux/arm64`. Other Ferrum Edge releases, gateway modes, and
browsers remain best-effort or not qualified.
[Supported pairing](docs/compatibility.md) records the requirements, Node
floors, and tested scale.

## Contracts

The org's shared vocabularies, JSON schemas, and fixtures live in
[ferrum-edge/ferrum-contracts](https://github.com/ferrum-edge/ferrum-contracts).
Foundry vendors the `plugin-catalog` and `provisioned-by` vocabularies with
their vocabulary schemas, plus the implemented service-manifest schema, all
its valid/invalid fixtures and the canonical invalid-expectations file, under
[`contracts/ferrum-contracts/`](contracts/ferrum-contracts/), pinned to
`contracts-edge-0.9.21` at `92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f` in
[`contracts/ferrum-contracts/PIN`](contracts/ferrum-contracts/PIN). The vendored
files, Foundry's local plugin names and provisioning markers, and the pin's tie
to the paired Edge release are checked by
[Plugin configuration templates](docs/plugin-defaults.md#shared-plugin-catalog-contract).
Foundry adopts only the 37 files listed in its pin: it does not vendor the
deployment-snapshot or backend-egress-policy schemas or adopt the native
deployment profile, and diagnostic import remains future work. The pin's
release and qualification evidence are in the
[pairing record](docs/compatibility.md#qualification-evidence).
The [Alloy manifest preview](docs/alloy-manifest-preview.md) consumes
the existing fields through an authenticated, read-only BFF route.

A shared contract changes in `ferrum-contracts` first, then is re-vendored here;
never edit a vendored file locally.

## Development status

Ferrum Foundry is in active buildout and has no users yet. Expect breaking
changes; earlier development versions get no compatibility or upgrade path.
When a contract changes, update the code, tests, demo data, and docs together.

Foundry has no database, SQL schema, or migrations. Gateway data and its schema
belong to Ferrum Edge. If Foundry ever adds its own database during buildout,
keep one canonical initial schema instead of a chain of migrations. Revisit
this policy before onboarding users.

## Features

- **Resource management**: create, edit, and delete proxies (HTTP and
  TCP/UDP/DTLS stream routes), consumers, plugins, and upstreams, with
  server-paginated tables and complete-collection search.
- **Relational browsing**: move between a proxy, its plugins, its upstream,
  and targets (with subsets and locality) through tabs and breadcrumbs.
- **Consumer credentials**: key-auth, JWT, HMAC, and mTLS rotation arrays with
  ACL groups. Basic-auth passwords can be appended, replaced, or deleted; the
  gateway never returns them, so their presence shows as unknown.
- **Plugins**: a category-grouped catalog of 80+ gateway plugins (auth,
  security/WAF, traffic control, AI gateway, mesh, observability, billing) with
  default config templates, per-instance execution triggers, and
  global/proxy/group scope.
- **TLS management**: fleet-global certificate, CA, CRL, OCSP, and JWKS
  stores; ACME order automation (HTTP-01, TLS-ALPN-01, DNS-01); inventory with
  expiry tracking; surface rotation; and PEM validation. See
  [waiting-operation deadlines](docs/deployment.md#live-apply-monitoring-and-acme-issuance-deadlines)
  for live-apply monitoring and re-checking interrupted issuance.
- **API spec import**: create spec-managed proxies, upstreams, and plugins from
  OpenAPI documents (`x-ferrum-proxy` extensions), then replace or delete them
  as a unit.
- **Metrics**: gateway stats, overload protection, host runtime, circuit
  breakers, connection pools, health checks, load balancers, caches, API
  chargeback, Prometheus, and per-route metrics, under one refresh policy.
  Each panel shows when its own data was last fetched.
- **Operations**: audit log with filters and redacted diffs, CP/DP cluster
  topology, backend protocol capability probes, and full configuration backup
  and restore.
- **Mesh observability** (mesh-mode gateways): service graph, config and slice
  drift, policy denies, runtime overlays, remote clusters and federation,
  egress scope testing, waypoints, and SPIFFE gateway trust.
- **Health**: gateway readiness, listeners, audit and logging loss, database
  polling, trust freshness, and mode-specific runtime diagnostics.
- **Namespaces**: work across tenant namespaces with `X-Ferrum-Namespace`.
  Each operation stays bound to the namespace it started in (see
  [namespace binding](docs/authentication.md#namespace-binding)).
  Process-wide surfaces such as TLS stay fleet-global.
- **Dark and light themes**: dark by default, with a toggle in the header.

## Architecture

```
Browser <-> Fastify BFF (Node.js) <-> Ferrum Admin API
                |
          JWT generation
          TLS trust store
          Timeout enforcement
          SPA serving (prod)
```

The BFF (backend-for-frontend) does what a browser cannot: it holds the TLS
trust store, enforces connect/read/write timeouts, and signs admin JWTs.

The UI never presents a failed read as fact. A failed read cannot show an empty
collection, current health, or an authorization decision. Each input reports
its own failure and retry, a failed refresh names its last successful
observation, and policy or trust conclusions become **unknown**. Collections
that fail to load (such as audit and API specs) hide their rows and row
actions.

Editors keep your draft when a refresh fails: the form stays mounted and shows
a retry notice, and recovery never overwrites a draft for the same resource.
See [editor identity](docs/authentication.md#editor-identity) and
[plugin membership](docs/plugin-membership.md).

## Quick Start

Deploying rather than developing? Start with
[Getting started](docs/getting-started.md). The runnable stack in
[`deploy/starter/`](deploy/starter/README.md) takes you from nothing to an
authenticated request through the real data plane. Its `demo` profile needs no
gateway or identity provider of your own.

### Prerequisites

- Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+. The container image runs
  Node.js 24 LTS.
- npm 10+

### Local Development

```bash
npm install

export FERRUM_ADMIN_URL=http://127.0.0.1:9000         # Ferrum Admin API URL
export FERRUM_JWT_SECRET=$(openssl rand -hex 32)      # HS256 signing key, 32+ bytes; must match the gateway
export FERRUM_BFF_AUTH_TOKEN=$(openssl rand -hex 32)  # development sign-in token
export FERRUM_JWT_NAMESPACES='*'                      # namespace scope: exact names, or * for every namespace

npm run dev
```

`npm run dev` starts Vite on port 5173 and the BFF on port 3001. Open
http://localhost:5173.

Static-token sign-in is for local development only. The SPA exchanges
`FERRUM_BFF_AUTH_TOKEN` once for an HttpOnly, SameSite session cookie; the
token is never stored in the browser or reused as a bearer token. Production
startup (`NODE_ENV=production`) rejects static auth by default; configure
`FERRUM_AUTH_MODE=trusted-proxy` behind an identity proxy. See
[Production authentication](docs/authentication.md).

`FERRUM_JWT_NAMESPACES` scopes the development principal and is required in
static mode: a comma-separated list of exact namespace names, or `*` alone for
every namespace. Startup fails when it is unset or names no namespace (empty,
whitespace, or commas only).

Common optional variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | BFF port. Vite also proxies `/api` to it when `VITE_BFF_URL` is unset |
| `VITE_DEV_HOST` | `localhost` | Vite listen address: `localhost`, `127.0.0.1`, `::1`, or an explicit IP. A non-loopback address (`0.0.0.0`, `::`) is an explicit opt-in |
| `VITE_DEV_PORT` | `5173` | Vite port (1-65535) |
| `VITE_BFF_URL` | `http://localhost:$PORT` | `http`/`https` origin Vite proxies `/api` to; overrides `PORT` |
| `FERRUM_JWT_TTL` | `900` | JWT lifetime in seconds |
| `FERRUM_JWT_ROLE` | `admin` | Development role: `viewer`, `operator`, or `admin` |
| `FERRUM_JWT_AUDIENCE` | - | Exact `aud` value(s), comma separated |
| `FERRUM_TLS_CA_PATH` | - | PEM truststore for an `https` admin API |
| `FERRUM_TLS_VERIFY` | `true` | Verify the admin API certificate. Production requires verification for remote admin URLs unless `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` |

Invalid values fail startup. The full list, with ranges, is in the
[configuration reference](docs/deployment.md#2-configuration-reference).

**Use one hostname.** The session cookie is host-scoped, and `localhost` and
`127.0.0.1` are different hosts. The examples use `localhost` throughout. On
dual-stack hosts Vite's `localhost` may bind only `[::1]`, so
`http://127.0.0.1:5173` is refused; set `VITE_DEV_HOST=127.0.0.1` (and the
same host in `VITE_BFF_URL`) to force IPv4.

**Running next to another Vite app.** Change the ports. One `PORT` value keeps
the BFF and Vite's `/api` proxy aligned:

```bash
VITE_DEV_PORT=5174 PORT=3002 npm run dev
```

To use a BFF that is already running elsewhere, set `VITE_BFF_URL` (for
example `http://localhost:3002`) instead of `PORT`.

### Mock gateway

No gateway handy? The bundled mock admin API serves sample data for most
surfaces (CRUD, TLS/ACME, audit, cluster, overload, chargeback, gateway trust
bundles):

```bash
node scripts/mock-admin-gateway.mjs   # 127.0.0.1:9000 (MOCK_ADMIN_BIND, MOCK_ADMIN_PORT)
```

`MOCK_GATEWAY_MODE=file` makes it a read-only gateway. Writes follow the live
Edge contract:

- proxy `auth_mode` is `single` or `multi`;
- plugin configs need `plugin_name` and `scope` (a top-level `name` is
  rejected as unknown);
- creates of proxies, consumers, upstreams, and plugin configs record
  `labels.provisioned-by` from `X-Ferrum-Provisioned-By` unless the body sets
  it; `PUT` without `labels` keeps the stored labels; empty label maps are
  omitted;
- plugin config `PUT`/`DELETE` require `expected_proxy_ids` (an empty value
  expects none): the mock implements the newer Edge association precondition
  described in [plugin membership](docs/plugin-membership.md#scope-changes-and-proxy-scoped-plugins),
  which the paired v0.9.20 enforces.

`GET /admin/metrics` follows `MOCK_GATEWAY_MODE` too: with `cp` or
`node_agent` it returns Ferrum Edge's no-proxy-state skeleton (zeroed runtime
counters, empty pools and caches, `config_last_updated_at: null`), which the
Metrics page and Dashboard show as not reported rather than as measured zeros.

`GET /mesh/service-graph` always returns sample data, and with
`MOCK_GATEWAY_MODE=mesh` so does `GET /mesh/runtime-overlay`; other `/mesh/*`,
`/node-waypoint/*`, and `/service-waypoint/*` routes answer `404`, and the UI
shows empty states. Use a mesh-mode Ferrum Edge
gateway to see the mesh surfaces.

### Seeding a real gateway

`scripts/seed-demo-gateway.mjs` loads demo resources into a real gateway. It
**replaces the whole target namespace**, so use a dedicated namespace and
confirm the exact target:

```bash
# FERRUM_JWT_SECRET must be the gateway's admin signing key.
FERRUM_NAMESPACE=ferrum-foundry-demo \
FERRUM_DEMO_CONFIRM_TARGET='http://127.0.0.1:9000#ferrum-foundry-demo' \
node scripts/seed-demo-gateway.mjs
```

`FERRUM_DEMO_CONFIRM_TARGET` must equal `<FERRUM_ADMIN_URL>#<FERRUM_NAMESPACE>`
exactly, or the script stops before sending any request. After confirmation it
runs preflight checks, then restores the namespace with `POST /restore`:

- **Global `prometheus_metrics`**: Ferrum Edge allows one enabled global
  instance. If another namespace already has one, the seed leaves out its own
  and prints the owning namespace. Demo routes do not depend on it.
- **Basic auth**: off by default; those routes and upstreams are left out
  rather than exposed unauthenticated. Set `FERRUM_DEMO_INCLUDE_BASIC_AUTH=true`
  to include them. The gateway then needs `FERRUM_BASIC_AUTH_HMAC_SECRET`
  (32+ bytes); the seeder checks it with a probe credential and exits with
  status 1, before restoring, if it is missing.

Other inputs:

- The seed is deterministic and safe to rerun.
- `FERRUM_JWT_AUDIENCE`: set it if the gateway requires an admin audience.
- `FERRUM_DEMO_BACKEND_HOST`: host of the demo backends (default
  `127.0.0.1`); use a Docker host alias for a containerized gateway.
- `FERRUM_DEMO_PROXY_URL`: data-plane origin (default `http://127.0.0.1:8000`).
- `FERRUM_ADMIN_URL` (default `http://127.0.0.1:9000`) must be `https`, or
  `http` to a loopback address (`127.0.0.0/8`, `::1`, or `localhost`). The
  seeder and the helpers that share its configuration (verify, route smoke,
  contract smoke, capability parity) send signed admin tokens and stop before
  signing anything for a plaintext origin on another host. They have no
  override; reach a containerized gateway through a published loopback port.
- Run the gateway with `FERRUM_NAMESPACE=ferrum-foundry-demo` so it serves the
  seeded routes.

`scripts/verify-demo-gateway.mjs` and `scripts/demo-route-smoke.mjs` read the
manifest the seeder writes, so they check the same basic-auth and Prometheus
choices it made.

### Production Build

For a complete, supported production deployment (Foundry, a TLS-terminating
identity proxy, and the gateway connection), use the starter's
[production profile](deploy/starter/README.md#production).
[Getting started](docs/getting-started.md) walks through its disposable demo
profile.

`npm run build` compiles the UI into `dist/` and the BFF into `dist-server/`.
`npm start` serves the compiled UI only when `NODE_ENV=production`. Without it,
as with the local development variables above, `npm start` runs the BFF API
alone and `GET /` answers a JSON `404`; that mode only backs the Vite dev
server (`npm run dev`).

Production mode refuses static-token authentication by default (see
`FERRUM_ALLOW_INSECURE_STATIC_AUTH`, which you should not set) and the
published development secrets, so the built UI runs behind a trusted identity
proxy on the same host:

```bash
npm run build

export NODE_ENV=production
export FERRUM_AUTH_MODE=trusted-proxy
export FERRUM_TRUSTED_PROXY_SECRET="$(openssl rand -hex 32)" # the proxy sends it
export FERRUM_ADMIN_URL=https://ferrum-admin.internal:9000   # https unless loopback
export FERRUM_JWT_SECRET="$(openssl rand -hex 32)"           # also configure this on Ferrum Edge
export FERRUM_AUTH_LOGIN_URL=/oauth2/start
export FERRUM_AUTH_LOGOUT_URL=/oauth2/sign_out
export FERRUM_BIND_ADDRESS=127.0.0.1 # reachable only through the proxy
export PORT=3001
# If the gateway sets FERRUM_ADMIN_JWT_AUDIENCE, send the same value:
# export FERRUM_JWT_AUDIENCE=ferrum-admin
# If the admin API certificate is issued by a private CA, keep TLS
# verification on and trust that CA:
# export FERRUM_TLS_CA_PATH=/etc/ferrum/admin-ca.pem
npm start
```

The BFF now serves the built UI at `/`, but browsers reach it only through the
identity proxy's public HTTPS URL. The proxy terminates TLS, runs the sign-in
flow, injects the identity headers on every request, and forwards to
`http://127.0.0.1:3001`. Production defaults to `Secure` cookies and HSTS, so behind a
plain-HTTP browser URL on a non-loopback host the browser drops the CSRF
cookie and every save fails. Protected endpoints refuse a
request without the proxy's identity assertion; for example,
`GET /api/auth/session` answers `401`.

- [Production authentication](docs/authentication.md#production-trusted-identity-proxy)
  lists the headers the proxy must strip and inject.
- [Deployment](docs/deployment.md#3-reverse-proxy-example-nginx-and-oauth2-proxy)
  has an nginx and oauth2-proxy configuration written for the starter's
  Compose network, where nginx reaches `foundry:8080` and `oauth2-proxy:4180`
  by service name. For a source build behind nginx on the same host, point
  Foundry's `location /` upstream at `http://127.0.0.1:3001`, point both
  `/oauth2/` locations (including the internal `/oauth2/auth` subrequest) at
  your oauth2-proxy listener, such as `http://127.0.0.1:4180`, configure
  oauth2-proxy for your identity provider, and set its trusted proxy range to
  the nginx peer address in that topology. Install (or repoint) the files the
  starter supplies through Compose mounts: `nginx/identity/policy.conf` and
  `nginx/identity/inject.conf` at the absolute paths `foundry.conf` includes,
  and the proof include `/etc/nginx/secrets/ferrum-proxy-secret.conf` rendered
  with the BFF's exact `FERRUM_TRUSTED_PROXY_SECRET`, as described in the
  [starter's production steps](deploy/starter/README.md#production). The
  example needs nginx with TLS and the `auth_request` module; keeping its `http2 on;` line also needs
  nginx 1.25.1 or newer built with the HTTP/2 module. On any nginx without
  that, remove `http2 on;` and keep the rest.
- [Gateway transport](docs/deployment.md#gateway-transport) covers the admin
  API TLS settings, and the
  [downstream JWT claims](docs/deployment.md#downstream-jwt-claims) table covers
  the audience.

### Docker

```bash
docker build -f docker/Dockerfile -t ferrum-foundry .

export FERRUM_JWT_SECRET=$(openssl rand -hex 32) # also configure this on Ferrum Edge
export FERRUM_TRUSTED_PROXY_SECRET=$(openssl rand -hex 32)

docker run \
  -e FERRUM_ADMIN_URL=https://your-gateway:9443 \
  -e FERRUM_JWT_SECRET \
  -e FERRUM_AUTH_MODE=trusted-proxy \
  -e FERRUM_TRUSTED_PROXY_SECRET \
  -p 127.0.0.1:8080:8080 \
  ferrum-foundry
```

In production the BFF must be reachable only through the identity proxy; see
[Deployment](docs/deployment.md). It also refuses to start with a plaintext
`http://` admin URL unless the host is a loopback address (`127.0.0.0/8`,
`::1`, or `localhost`), because every admin request carries a signed bearer
token. The image is based on `gcr.io/distroless/nodejs24-debian13:nonroot`: no
shell, no package manager, and no Node package managers. It runs as the numeric
non-root user `65532` with Node as its entrypoint. Build inputs are allowlisted
by `.dockerignore`, base images are pinned by digest, and published images carry
provenance and SBOM attestations. Release version tags are never reassigned:
the release workflow refuses to publish over an existing `vX.Y.Z` or `X.Y.Z`
image with a different digest. See
[Release and supply-chain gates](docs/release-security.md).

## Documentation

- [Getting started](docs/getting-started.md): from install to a first authenticated request, using [`deploy/starter/`](deploy/starter/README.md)
- [Deployment](docs/deployment.md): production topology, configuration reference, reverse proxy and Kubernetes examples, go-live checklist
- [Production authentication](docs/authentication.md): trusted-proxy identity contract and downstream JWT claims
- [Operator visibility](docs/operator-visibility.md): health and audit evidence, proxy-bound specs, mesh runtime
- [Supported pairing](docs/compatibility.md): the qualified Ferrum Edge image, tested envelope, best-effort and unqualified modes
- [MCP Tools tab](docs/mcp-tools.md): the node-local MCP tool catalog, per-tool policy edits, and per-group grants
- [Critical journeys](e2e/README.md): the browser-to-gateway release gate and how to run it locally
- [Release and supply-chain gates](docs/release-security.md): publication gates, image tags, provenance and SBOM
- [Security](SECURITY.md): supported versions and private vulnerability reporting
- [Changelog](CHANGELOG.md)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 6, Tailwind CSS v4 |
| Routing | TanStack Router v1 |
| Data | TanStack Query v5 |
| UI | Radix UI primitives (Dialog, Select, Tabs) |
| Backend | Node.js, Fastify 5 |
| JWT | jose (HS256) |
| Docker | Distroless Node.js 24 (Debian 13), non-root |

## Resource attribution

The BFF sends `X-Ferrum-Provisioned-By: ferrum-foundry` on every proxied admin
request, and the demo seeder does the same. A gateway with resource-label
support records it as `labels.provisioned-by` on newly created proxies,
consumers, upstreams, and plugin configs, including API-spec imports. Existing labels survive edits, and restore keeps recorded origins.
Detail pages show all labels, including those set by other tools.

Labels are informational. They do not affect authentication, ownership, or
routing. Gateways without label support ignore the header, and resources
created before it are not labeled retroactively.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) - See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for commercial licensing.
