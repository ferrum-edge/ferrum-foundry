# Client-side capability model

Foundry presents a mutation surface read-only when it already knows the write
would be refused. The model **mirrors** the gateway's authorization matrix; it
never replaces it. Ferrum Edge and the BFF still authorize every request, and
the ordinary API error dialog still reports a genuine, unexpected denial.

The model lives in `src/lib/capabilities.ts`, is published by
`CapabilityProvider` (`src/stores/capabilities.tsx`), and is read with
`useCapabilities()`.

## Inputs

Two facts drive every verdict, both already read by the UI:

| Fact | Source |
| --- | --- |
| `role` | `principal.role` on the Foundry session (`GET /api/auth/session`) — `viewer`, `operator`, or `admin` |
| `mode` | `mode` on the authenticated gateway health snapshot (`GET /health`) |
| `adminWritesEnabled` | `admin_writes_enabled` on the same snapshot |

`CapabilityProvider` reads one health snapshot for the whole workspace and only
accepts it while `resolveReadState` says `loaded`. A stale or failed read
contributes `null`, exactly like a snapshot that was never fetched.

## Read truthfulness

A fact that has not been read is `null` and concludes nothing. An unknown role
or an unread health snapshot leaves every surface **enabled** and lets the
server answer, which is also what `useCapabilities()` returns outside a
provider. Only a positively observed denial renders a surface read-only, so the
UI never invents an authorization conclusion from a failed read.

## Gateway write state

`resolveGatewayWriteState()` classifies whether the gateway accepts persisted
configuration mutations at all:

| Observation | State |
| --- | --- |
| `mode` is `file`, `dp`, or `mesh` | `read-only` — configuration is owned by a config file, the control plane, or mesh policy sources. Upstream `openapi.yaml` calls these three the "read-only" modes. |
| `admin_writes_enabled === false` | `read-only` — a read-only admin API, an unavailable configuration database, or a failover topology without `FERRUM_DB_FAILOVER_ALLOW_WRITES=true` |
| `admin_writes_enabled === true` | `enabled` |
| neither observed | `unknown` — surfaces stay enabled |

The mode check runs first because it names a cause the operator can act on.

## Surface matrix

Role requirements follow the upstream contract: `viewer` reads, `operator`
additionally mutates proxies, upstreams, plugin configs and operational
endpoints, and `admin` covers consumers, credentials, API specs, TLS material,
gateway trust, batch/restore, the namespace registry, and audit.

| Surface | Minimum role | Blocked by a read-only gateway |
| --- | --- | --- |
| `proxies` | `operator` | yes |
| `upstreams` | `operator` | yes |
| `pluginConfigs` | `operator` | yes |
| `operationalActions` (TLS rotate/validate, capability refresh, egress dry-run) | `operator` | no |
| `consumers` | `admin` | yes |
| `consumerCredentials` | `admin` | yes |
| `apiSpecs` | `admin` | yes |
| `namespaceRegistry` | `admin` | yes |
| `configBackup` (`POST /restore`) | `admin` | yes |
| `gatewayTrust` | `admin` | yes |
| `configExport` (`GET /backup`) | `admin` | no |
| `tlsMaterial` (certificates, CA bundles, CRLs, OCSP, JWKS, ACME) | `admin` | no |
| `bffSettings` (`PUT /api/settings`, BFF-local) | `admin` | no |

`tlsMaterial` stays off the config-store gate because managed TLS and ACME
records live in independent stores that `admin_writes_enabled` deliberately
does not gate. `operationalActions` endpoints persist no configuration and
remain available in the read-only modes. `configExport` and `bffSettings` are
reads and BFF-local writes respectively, so neither depends on the gateway's
configuration store.

A role denial is reported ahead of a gateway-mode denial: it is the more
fundamental and the more stable of the two.

## Presentation

`src/components/shared/CapabilityGate.tsx` renders the verdict:

- `CapabilityNotice` — the visible reason: the surface's `headline` plus the
  `explanation`. It is a `role="status"` region carrying
  `data-capability-blocked="role" | "gateway-read-only"`.
- `ReadOnlySurface` — the notice plus a `disabled` fieldset (`display:
  contents`, so layout is unchanged) around a whole editing surface.
- `WriteAction` — a single unavailable action with a short reason beside it.

A disabled control is never the only signal: every read-only surface carries
visible text naming the role or the gateway mode **before** the user edits
anything. Forms additionally refuse to submit while their capability is denied,
so a programmatic submit cannot slip past the presentation.

## Adding a surface

1. Add the key to `CapabilitySurface` and a descriptor to `SURFACES`, choosing
   `minimumRole` and `configStore` from the upstream `openapi.yaml` contract
   (a `ReadOnly` 403 response means `configStore: true`; a bare `Forbidden`
   means role-only). Write the `headline` as a full sentence — an editing
   surface is "read-only", a one-off action is "unavailable".
2. Read it with `useCapabilities()` and render `CapabilityNotice`,
   `ReadOnlySurface`, or `WriteAction`.
3. Guard the mutation handler with `if (!capability.allowed) return;`.
4. Extend `src/lib/capabilities.test.ts` with the new row.

## Reproducing locally

`scripts/mock-admin-gateway.mjs` reports the mode and enforces the matching
refusal, so both denials can be reproduced without a gateway build:

```bash
# read-only admin API: /health reports file mode and config writes return 403
MOCK_GATEWAY_MODE=file node scripts/mock-admin-gateway.mjs

# viewer session: the BFF signs a viewer JWT
FERRUM_JWT_ROLE=viewer npm run dev
```
