# Ferrum Foundry

Admin panel UI for managing and observing the [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge) Gateway.

## Features

- **Resource Management** - Full CRUD for Proxies, Consumers, Plugins, and Upstreams with paginated tables supporting 50k+ records via virtual scrolling
- **Relational Browsing** - Navigate Proxy -> Plugins -> Upstream -> Targets with tabs and breadcrumbs
- **Consumer Credentials** - Manage key-auth, basic-auth, JWT, HMAC, and mTLS credentials with ACL groups
- **Plugin Configuration** - JSON editor for all 46+ gateway plugins with scope (global/proxy) support
- **Metrics Dashboard** - Gateway stats, circuit breakers, connection pools, health checks, load balancers, caches, and Prometheus metrics with configurable auto-refresh
- **Health Monitoring** - Real-time gateway and database health status
- **Namespace Support** - Browse and manage resources across namespaces via `X-Ferrum-Namespace`
- **Dark Theme** - Consistent design matching the Ferrum Edge brand

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

## Quick Start

### Prerequisites

- Node.js 22+
- npm 10+

### Local Development

```bash
npm install
```

Set required environment variables:

```bash
export FERRUM_ADMIN_URL=http://localhost:9000   # Ferrum Admin API URL
export FERRUM_JWT_SECRET=your-jwt-secret         # HS256 signing key
```

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `FERRUM_JWT_ISSUER` | `ferrum-edge` | JWT issuer claim |
| `FERRUM_JWT_TTL` | `3600` | JWT token TTL (seconds) |
| `FERRUM_TLS_CA_PATH` | - | Path to .pem truststore |
| `FERRUM_TLS_VERIFY` | `true` | Verify TLS certificates |
| `FERRUM_CONNECT_TIMEOUT` | `5000` | Connection timeout (ms) |
| `FERRUM_READ_TIMEOUT` | `60000` | Read timeout (ms) |
| `FERRUM_WRITE_TIMEOUT` | `60000` | Write timeout (ms) |
| `PORT` | `3001` | BFF server port |

Start the dev server:

```bash
npm run dev
```

This starts Vite (port 5173) and Fastify (port 3001) concurrently. Open http://localhost:5173.

### Production Build

```bash
npm run build
npm start
```

### Docker

```bash
docker build -f docker/Dockerfile -t ferrum-foundry .

docker run \
  -e FERRUM_ADMIN_URL=http://your-gateway:9000 \
  -e FERRUM_JWT_SECRET=your-secret \
  -p 8080:8080 \
  ferrum-foundry
```

The Docker image uses `gcr.io/distroless/nodejs22-debian12:nonroot` for a minimal attack surface.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Tailwind CSS v4 |
| Routing | TanStack Router v1 |
| Data | TanStack Query v5, TanStack Table v8, TanStack Virtual v3 |
| UI | Radix UI primitives (Dialog, Select, Tabs, Tooltip) |
| Backend | Node.js, Fastify 5 |
| JWT | jose (HS256) |
| Docker | Distroless Node.js 22 |

## License

[PolyForm Noncommercial 1.0.0](LICENSE) - See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for commercial licensing.
