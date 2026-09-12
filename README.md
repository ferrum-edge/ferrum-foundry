<p align="center">
  <img src="docs/ferrum_foundry.png" alt="Ferrum Foundry" width="300" />
</p>

<h1 align="center">Ferrum Foundry</h1>

<p align="center">
  <a href="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/ci.yml"><img src="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/release.yml"><img src="https://github.com/ferrum-edge/ferrum-foundry/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="https://github.com/ferrum-edge/ferrum-foundry/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-22.19%2B%20%7C%2024%20%7C%2026%2B-brightgreen" alt="Node.js 22.19+, 24.x, or 26+ (image: 24 LTS)" />
  <img src="https://img.shields.io/badge/TypeScript-6-blue" alt="TypeScript" />
</p>

Admin panel UI for managing and observing the [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge) Proxy/Gateway.

## Features

- **Resource Management** - Full CRUD for Proxies (HTTP + TCP/UDP/DTLS stream routes), Consumers, Plugins, and Upstreams with server-paginated tables and complete-collection search
- **Relational Browsing** - Navigate Proxy -> Plugins -> Upstream -> Targets (with subsets and locality) via tabs and breadcrumbs
- **Consumer Credentials** - Manage key-auth, JWT, HMAC, and mTLS rotation arrays with ACL groups; append, replace, or delete all basic passwords while showing their presence as unknown (the gateway omits basic credentials from ordinary responses)
- **Plugin Configuration** - Category-grouped catalog of 80+ gateway plugins (auth, security/WAF, traffic control, AI gateway, mesh, observability, billing) with default config templates, per-instance execution triggers, and scope (global/proxy/group) support
- **TLS Management** - Fleet-global certificate/CA/CRL/OCSP/JWKS stores, ACME order automation (HTTP-01/TLS-ALPN-01/DNS-01), material inventory with expiry tracking, surface rotation, and PEM validation. [Waiting-operation deadlines](docs/deployment.md#live-apply-monitoring-and-acme-issuance-deadlines) cover live-apply monitoring and safe status re-checks after interrupted issuance.
- **API Spec Import** - Create spec-managed proxies, upstreams, and plugins from OpenAPI documents (`x-ferrum-proxy` extensions) with replace/delete lifecycle
- **Metrics Dashboard** - Gateway stats, overload protection, host runtime, circuit breakers, connection pools, health checks, load balancers, caches, API chargeback, and Prometheus metrics with one refresh policy across all panels, including per-route metrics. Manual stops periodic reads; Refresh Now refreshes every panel. Each independently fetched panel identifies its last successful sample, while the toolbar timestamp applies only to admin metrics. Control-plane and node-agent gateways show omitted pool/cache metrics as not reported; available gateway metrics remain visible
- **Operations** - Audit log with filters and redacted diffs, CP/DP cluster topology, backend protocol capability probes, and full configuration backup/restore
- **Mesh Observability** - Service graph, config/slice drift, policy denies, remote clusters and federation, egress scope testing, waypoints, and SPIFFE gateway trust (mesh-mode gateways)
- **Health Monitoring** - Real-time gateway, database, and FIPS/readiness status
- **Namespace Support** - Browse and manage tenant resources across namespaces via `X-Ferrum-Namespace`; every operation is bound to the namespace active when it started (see `docs/authentication.md` → "Namespace binding"), and process/runtime surfaces such as TLS management remain fleet-global
- **Dark / Light Theme** - Dark theme by default with a light theme toggle in the header

## Architecture

```
Browser <-> Fastify BFF (Node.js) <-> Ferrum Admin API
                |
          JWT generation
          TLS trust store
          Timeout enforcement
          SPA serving (prod)
```

The BFF (Backend-for-Frontend) handles TLS trust stores, connection/read/write timeouts, and JWT generation server-side - capabilities browsers cannot provide.

Read truthfulness is an explicit UI invariant: a failed read cannot establish an
empty collection, current health, or an authorization conclusion. Shared
`ReadState` handling distinguishes loading, successful reads, unavailable reads,
and failed refreshes with retained data. Each independent input reports its own
failure and retry; failed refreshes identify the last successful observation.
Policy and trust conclusions become **unknown**, and unavailable audit/API-spec
collections hide their rows and row actions. Pending spec replacement and deletion
also require an available collection. The dashboard offers manual refresh and
labels its observation times.

Detail editors follow a separate draft-preservation rule: a failed refresh with
cached data keeps the editor mounted and shows a non-blocking retry notice. Plugin
membership must load completely before the first edit; subsequent failures disable
the picker without clearing selections or other fields. Recovery never reseeds a
draft for the same identity. See [editor identity](docs/authentication.md#editor-identity)
and [plugin membership](docs/plugin-membership.md).

## Quick Start

### Prerequisites

- Node.js 22.19+ within 22.x, 24.x, or 26+. The published container image runs Node.js 24 LTS. This range satisfies both Undici's runtime floor and Vitest 5's supported Node versions.
- npm 10+

### Local Development

```bash
npm install
```

Set required environment variables:

```bash
export FERRUM_ADMIN_URL=http://localhost:9000   # Ferrum Admin API URL
export FERRUM_JWT_SECRET=$(openssl rand -hex 32)       # HS256 signing key (32+ chars)
export FERRUM_BFF_AUTH_TOKEN=$(openssl rand -hex 32)  # Development login exchange token
```

Static-token authentication is intended for local development only. The SPA
exchanges `FERRUM_BFF_AUTH_TOKEN` once for a bounded HttpOnly, SameSite session;
the deployment credential is never stored in browser storage or reused as a
bearer token. Production startup fails closed unless a trusted identity proxy
mode is configured. See [Production authentication](docs/authentication.md).

The most commonly adjusted optional variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | BFF server port |
| `FERRUM_JWT_TTL` | `900` | JWT token TTL (seconds) |
| `FERRUM_JWT_ROLE` | `admin` | Static development role: viewer/operator/admin |
| `FERRUM_JWT_AUDIENCE` | - | Optional exact audience claim(s), comma separated |
| `FERRUM_TLS_CA_PATH` | - | Path to a .pem truststore (contained projected-volume symlinks are supported) |
| `FERRUM_TLS_VERIFY` | `true` | Verify TLS certificates |

Every environment variable the BFF reads, with its default, allowed range, and
meaning, is listed in the
[configuration reference](docs/deployment.md#2-configuration-reference).

Start the dev server:

```bash
npm run dev
```

This starts Vite (port 5173) and Fastify (port 3001) concurrently. Open http://localhost:5173.

No gateway handy? Run the bundled mock admin API, which serves realistic
sample data for every admin surface (CRUD, TLS/ACME, audit, cluster, mesh,
chargeback). Write paths follow the live Edge contract: proxy `auth_mode` is
only `single` or `multi` (not `none`), and plugin configs require `plugin_name`
and `scope` — a top-level `name` field is unknown:

```bash
node scripts/mock-admin-gateway.mjs   # listens on :9000
```

To seed a real gateway, use a dedicated namespace. Seeding performs a full
replacement of that namespace, so it refuses to run without an explicit opt-in.
Preflight checks run after that confirmation and **before** `POST /restore`:

- **Global `prometheus_metrics`**: Ferrum Edge permits only one enabled
  global instance process-wide. The seeder lists plugin configs in every
  namespace it can see. If another namespace already owns that registry, the
  seed **omits** its own `demo-global-prometheus` fixture and prints the
  owning namespace. Demo routes do not depend on that plugin. A previous seed
  in the *target* namespace is replaced as usual.
- **Basic auth**: demo `basic_auth` plugins and `basicauth` consumers need
  Edge `FERRUM_BASIC_AUTH_HMAC_SECRET` (>= 32 bytes). They are **off by
  default**. Set `FERRUM_DEMO_INCLUDE_BASIC_AUTH=true` to include them; the
  seeder then creates and deletes a probe credential in the target namespace
  and aborts with exit status 1 if the secret is missing, still before restore.

```bash
# FERRUM_JWT_SECRET is the same 32+ character admin signing key used by Ferrum.
FERRUM_NAMESPACE=ferrum-foundry-demo \
FERRUM_DEMO_CONFIRM_TARGET='http://127.0.0.1:9000#ferrum-foundry-demo' \
node scripts/seed-demo-gateway.mjs

# Optional: include basic-auth demo routes (requires the HMAC secret on Edge).
FERRUM_NAMESPACE=ferrum-foundry-demo \
FERRUM_DEMO_CONFIRM_TARGET='http://127.0.0.1:9000#ferrum-foundry-demo' \
FERRUM_DEMO_INCLUDE_BASIC_AUTH=true \
node scripts/seed-demo-gateway.mjs
```

The confirmation must exactly match `<FERRUM_ADMIN_URL>#<FERRUM_NAMESPACE>`;
changing either target invalidates a previously copied confirmation before any
HTTP request is made. `scripts/verify-demo-gateway.mjs` and
`scripts/demo-route-smoke.mjs` follow the written seed manifest so they assert
the same optional basic-auth and prometheus choices the seeder actually restored.

The payload uses deterministic resource IDs and can be run repeatedly. It
includes the current versioned API-spec backup section, current credential-array
shapes, and the same admin JWT signer used by the BFF. If Ferrum requires an
admin audience, set the same value in `FERRUM_JWT_AUDIENCE`. Configure the demo
gateway itself with `FERRUM_NAMESPACE=ferrum-foundry-demo` so it serves the
seeded routes. Containerized gateways can reach a host-side demo backend by
setting `FERRUM_DEMO_BACKEND_HOST` to a Docker host alias; override
`FERRUM_DEMO_PROXY_URL` when the data-plane origin is not
`http://127.0.0.1:8000`.

### Production Build

```bash
npm run build
npm start
```

### Docker

```bash
docker build -f docker/Dockerfile -t ferrum-foundry .

export FERRUM_JWT_SECRET=$(openssl rand -hex 32) # also configure this on Ferrum Edge
export FERRUM_TRUSTED_PROXY_SECRET=$(openssl rand -hex 32)

docker run \
  -e FERRUM_ADMIN_URL=http://your-gateway:9000 \
  -e FERRUM_JWT_SECRET \
  -e FERRUM_AUTH_MODE=trusted-proxy \
  -e FERRUM_TRUSTED_PROXY_SECRET \
  -p 127.0.0.1:8080:8080 \
  ferrum-foundry
```

The production BFF must be reachable only through the configured identity
proxy. The Docker image uses `gcr.io/distroless/nodejs24-debian13:nonroot` for
a minimal attack surface. Build inputs are allowlisted by `.dockerignore`, base
images are digest-pinned, and published images carry provenance and SBOM
attestations. See [Release and supply-chain gates](docs/release-security.md).

## Documentation

- [Deployment](docs/deployment.md) - production topology, full configuration reference, reverse proxy / Compose / Kubernetes examples, and a go-live checklist
- [Production authentication](docs/authentication.md) - trusted-proxy identity contract and downstream JWT claims
- [Release and supply-chain gates](docs/release-security.md) - publication gates, image tags, provenance and SBOM
- [Security](SECURITY.md) - supported versions and how to report a vulnerability privately
- [Changelog](CHANGELOG.md) - notable changes

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Tailwind CSS v4 |
| Routing | TanStack Router v1 |
| Data | TanStack Query v5, TanStack Table v8, TanStack Virtual v3 |
| UI | Radix UI primitives (Dialog, Select, Tabs, Tooltip) |
| Backend | Node.js, Fastify 5 |
| JWT | jose (HS256) |
| Docker | Distroless Node.js 24 |

## License

[PolyForm Noncommercial 1.0.0](LICENSE) - See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for commercial licensing.
