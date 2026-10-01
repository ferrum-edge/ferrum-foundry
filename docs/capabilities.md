# Client-side capability model

Foundry shows a mutation surface read-only when it already knows the write
would be refused. The model **mirrors** the gateway's authorization matrix; it
never replaces it. Ferrum Edge and the BFF still authorize every request, and
the ordinary API error dialog still reports an unexpected denial.

The model lives in `src/lib/capabilities.ts`, is published by
`CapabilityProvider` (`src/stores/capabilities.tsx`), and is read with
`useCapabilities()`.

## Inputs

Every verdict comes from four facts, from two reads the UI already makes:

| Fact | Source |
| --- | --- |
| `role` | `principal.role` from the Foundry session (`GET /api/auth/session`): `viewer`, `operator`, or `admin`. Checked with `isGatewayRole()`, so an unexpected value becomes `null` |
| `mode` | `mode` from the authenticated gateway health snapshot (`GET /health`) |
| `adminWritesEnabled` | `admin_writes_enabled` from the same snapshot |
| `status` | `status` from the same snapshot (`ok` / `degraded` / `starting` / `unavailable` / `draining`) |

`CapabilityProvider` reads one health snapshot for the whole workspace and
accepts it only while `resolveReadState` reports `loaded`. A stale or failed
read adds nothing.

The **last snapshot that loaded is kept for the life of the provider**. A
gateway's mode and write policy are fixed at startup, so a past observation
stays true, and a failed background refetch (`useHealth` has
`staleTime: 30_000` and refetches on window focus) must not flip a form between
read-only and editable. Until a read has loaded, the facts are `null`. If the
BFF is pointed at another gateway, `GatewayTargetGate` unmounts the provider
with the rest of the workspace, so one gateway's mode is never shown as
another's (see [Gateway target binding](authentication.md#gateway-target-binding)).

## Read truthfulness

A fact that has not been read is `null` and concludes nothing. An unknown role
or an unread health snapshot leaves every surface **enabled** and lets the
server answer. `useCapabilities()` returns the same outside a provider. Only a
positively observed denial makes a surface read-only, so the UI never draws an
authorization conclusion from a failed read.

## Gateway write gates

Ferrum Edge admits a mutation through one of three paths, and they are not
interchangeable. Each Foundry surface names the one it mirrors. Function names
below are in Ferrum Edge's `src/admin/mod.rs`.

| Gate | Upstream admission | What denies it |
| --- | --- | --- |
| `config-store` | `AdminState::admit_write`, reported in `/health` as `admin_writes_enabled = !admin_writes_currently_blocked()` | a read-only mode, an unavailable configuration database, **or** a failover topology without `FERRUM_DB_FAILOVER_ALLOW_WRITES=true` |
| `read-only-mode` | `AdminState::admit_non_config_db_write`: the read-only gate plus the database-availability gate, deliberately **not** the failover gate | a read-only mode |
| `none` | no write gate: reads, and `admit_audited_operation`, which only takes part in the audit handoff | nothing the UI can observe |

`resolveReadOnlyModeState()` classifies the `read-only-mode` gate.
`resolveGatewayWriteState()` runs it first, then falls back to
`admin_writes_enabled`:

| Observation | `read-only-mode` | `config-store` |
| --- | --- | --- |
| `mode` is `file`, `dp`, `mesh`, or `node_agent` | `read-only` | `read-only` |
| any other mode, `admin_writes_enabled === false`, observed `status !== "degraded"` | `read-only` | `read-only` |
| `admin_writes_enabled === false`, `status` unread or `"degraded"` | `unknown` | `read-only` |
| `admin_writes_enabled === true` | `unknown` | `enabled` |
| neither observed | `unknown` | `unknown` |

The mode check runs first because it names a cause the operator can act on.
Those four modes always set `read_only: true` when they build `AdminState`
(`src/modes/file.rs`, `data_plane.rs`, `mesh/mod.rs`, `node_agent.rs`).
`database` and `cp` take the flag from `FERRUM_ADMIN_READ_ONLY`
(`database.rs`, `control_plane.rs`), which the mode string does not reveal.

On those two modes the flag can still be observed. `handle_health` forces
`status: "degraded"` when writes are blocked **and** the process is not
read-only. Edge's OpenAPI `HealthResponse` schema says the same: intentional
read-only mode does **not** set `degraded`. So on a mode outside the read-only
set, `admin_writes_enabled === false` with an observed `status` other than
`"degraded"` positively identifies `FERRUM_ADMIN_READ_ONLY`, and cannot be
caused by a failover-topology denial (that reports `degraded`). An unread
`status` concludes nothing.

A `read-only-mode` surface must **not** be gated on `admin_writes_enabled`
alone. That flag also includes the failover gate, which does not apply to the
independent TLS/ACME stores, so it would invent a denial the gateway does not
make.

## Surface matrix

Role requirements come from Edge's `body_consuming_route_role` and
`tls_route_required_role` in `src/admin/mod.rs`, not from the prose in
`openapi.yaml`. `viewer` reads. `operator` can also change proxies, upstreams,
plugin configs, and run operational endpoints. `admin` covers consumers,
credentials, API specs, TLS material, gateway trust, batch and restore, the
namespace registry, and audit.

| Surface | Minimum role | Gate | Upstream admission it mirrors |
| --- | --- | --- | --- |
| `proxies` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /proxies` |
| `upstreams` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /upstreams` |
| `pluginConfigs` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /plugins/config` |
| `operationalActions` (TLS rotate/validate, backend-capability refresh, egress dry-run) | `operator` | `none` | `admit_audited_operation`, or no gate |
| `consumers` | `admin` | `config-store` | `admit_write` on `POST/PUT/DELETE /consumers` |
| `consumerCredentials` | `admin` | `config-store` | `admit_write` on `/consumers/{id}/credentials/{type}` |
| `apiSpecs` | `admin` | `config-store` | `admit_write` on `/api-specs` |
| `namespaceRegistry` | `admin` | `config-store` | `admit_write` on `/namespaces` |
| `configBackup` (`POST /restore`) | `admin` | `config-store` | `admit_write` on `/restore` |
| `gatewayTrust` | `admin` | `config-store` | `admit_write` on `/gateway-trust-bundles` |
| `configExport` (`GET /backup`) | `admin` | `none` (denied on `node_agent`) | `handle_backup`: a read with no write gate; `node_agent` has no cached config |
| `tlsMaterial` (certificates, CA bundles, CRLs, OCSP, JWKS, ACME) | `admin` | `read-only-mode` | `admit_non_config_db_write`, called by all 18 mutation handlers in `src/admin/tls_management.rs` |
| `bffSettings` (`PUT /api/settings`, BFF-local) | `admin` | `none` | `requireRole('admin')` in `server/routes/settings.ts`; never reaches the gateway |

Two rows need explaining.

**`tlsMaterial` is `read-only-mode`, not `none`.** Managed TLS and ACME records
live in stores separate from the configuration database, so
`admin_writes_enabled` does not describe them. But every one of their 18
mutation handlers calls `admit_non_config_db_write`, which starts with the
read-only gate. On a `file`, `dp`, `mesh`, or `node_agent` gateway they return
`403 {"error":"Admin API is in read-only mode"}`, and so do `database` and `cp`
started with `FERRUM_ADMIN_READ_ONLY=true`, which the model detects as writes
disabled plus a non-`degraded` status. Rotate and validate are exceptions:
rotate goes through `admit_audited_operation` and validate has no gate, so
neither applies the read-only gate and both stay available in every mode.

**`configExport` is `none`, except on `node_agent`.** `GET /backup` is a read,
and `handle_backup` applies no write gate. `file`, `dp`, and `mesh` keep a
`cached_config` and serve it when there is no configuration database.
`node_agent` builds `AdminState` with `db: None` and `cached_config: None`, so
`handle_backup` returns `503 {"error":"Database unavailable and no cached
config"}`. The model denies export on that mode only. On every other read-only
mode, export stays available to an admin.

A role denial is reported before a gateway-mode denial, because it is the more
fundamental and more stable of the two.

## Presentation

`src/components/shared/CapabilityGate.tsx` renders the verdict:

- `CapabilityNotice`: the visible reason, the surface's `headline` plus the
  `explanation`. It carries `data-capability-blocked="role" | "gateway-read-only"`.
- `ReadOnlySurface`: the notice plus a `disabled` fieldset around a whole
  editing surface, linked to the notice with `aria-describedby`. It uses
  `display: contents` by default so layout is unchanged. Passing
  `contentClassName` gives it a real box, with `min-w-0`, because a fieldset
  inherits the browser's `min-width: min-content`, which Tailwind preflight does
  not reset.
- `WriteAction`: a single unavailable action with a short visible reason,
  linked with `aria-describedby`. The full explanation is included as visually
  hidden text, since a disabled control cannot be focused. The child gets
  `disabled: true` via `cloneElement`, so a denied button looks like other
  disabled controls.

A disabled control is never the only signal. Every read-only surface shows text
naming the role or gateway mode **before** the user edits anything. The reason
has `role="status"`, so a denial that appears after first paint is announced;
one present at first paint is not, which is why `aria-describedby` is also set.

`Input`, `Select` triggers, and the form `Checkbox` helpers use
`disabled:opacity-60 disabled:cursor-not-allowed`, so they look disabled inside
a `fieldset[disabled]` (which matches `:disabled`). HTTP-method chip labels
wrap an `sr-only` checkbox, so they use `has-[:disabled]:` to drop
`cursor-pointer` and hover styles. Native textareas under the fieldset are
styled in `src/styles/globals.css`.

Forms also refuse to submit while their capability is denied, so a
programmatic submit cannot get past the presentation.

### A read-only surface never shows less than the editable one

The `disabled` fieldset covers editing controls. Anything the role may still
**read** stays reachable:

- Collapsible sections are forced open.
  `useCollapsibleFormValidation(sections, readOnly)` opens every section,
  because the section toggle is a `<button>` the fieldset also disables, so a
  collapsed section could never be opened.
- The **Cancel** button sits outside the fieldset, so there is always a way
  back. Only the submit button is disabled.

## Adding a surface

1. Add the key to `CapabilitySurface` and a descriptor to `SURFACES`. Take
   `minimumRole` from `body_consuming_route_role` / `tls_route_required_role`
   in ferrum-edge `src/admin/mod.rs`, not from `openapi.yaml` prose. Choose
   `gate` from the admission function the handler calls: `admit_write` →
   `config-store`, `admit_non_config_db_write` → `read-only-mode`,
   `admit_audited_operation` or none → `none`. Write the `headline` as a full
   sentence: an editing surface is "read-only", a one-off action is
   "unavailable".
2. Read it with `useCapabilities()` and render `CapabilityNotice`,
   `ReadOnlySurface`, or `WriteAction`.
3. Guard the mutation handler with `if (!capability.allowed) return;`. Guard the
   *mutation*, not the button, when one control does both a read and a write.
4. Add the row to `src/lib/capabilities.test.ts` (the three gate lists must
   still partition `CAPABILITY_SURFACES`), and to
   `scripts/mock-admin-gateway.mjs` if the gateway refuses it in a read-only
   mode.
5. Add a parity probe to `WRITE_PROBES` in
   `scripts/capability-parity-contract.mjs`: a request that reaches the same
   role check and admission gate as the real write. Prefer a request that
   cannot change anything; a `DELETE` must use the reserved probe id and expect
   `404`. If the surface never reaches the gateway, list it in
   `BFF_ONLY_SURFACES` instead. The contract refuses to run while a surface has
   no probe.

## Drift

The role/mode matrix is copied from ferrum-edge by hand. CI checks the copy
against the pinned gateway image (`edge.image`, see
[compatibility.md](compatibility.md)) with
`scripts/capability-parity-contract.mjs`. As `viewer`, `operator`, and `admin`,
it sends each gateway-backed surface a probe that passes the same role check
and write gate as the surface's real writes, and fails when the gateway's
answer disagrees with `resolveCapability`: an allowed surface refused, a denied
one admitted, a different required role named, or a read-only denial missing.
`capabilityRequirement()` exposes each surface's role and gate, so the contract
compares against this model rather than a second copy.

- `DELETE` probes must return `404`; a successful deletion fails the contract.
- Writable runs require `FERRUM_DEMO_CONFIRM_TARGET` to name the gateway and
  namespace exactly, and must only target a disposable gateway.
- It runs against a writable `database` gateway (inside
  `npm run test:gateway-contract`) and against a second container started with
  `FERRUM_ADMIN_READ_ONLY=true`. It first proves the gateway is in the expected
  mode, so it cannot pass vacuously.

The MCP tool catalog read (`GET /proxies/{id}/mcp/tools`) is also probed as a
viewer-readable, namespace-scoped endpoint. Its disposable missing-proxy probe
must reach the handler: a `404` whose body is the handler's own
`{"error":"Proxy not found"}`, not a router's generic `Not Found`. The proxy
page's MCP Tools tab renders that read for every role; its per-tool policy
edit is a plugin configuration write, so it follows the `pluginConfigs`
verdict (`operator` and up, `config-store` gate) that the existing plugin
configuration write probes already cover, and adds no surface of its own.

The contract also checks reads, because a denial must not look like missing
data. Every role must get real collections for the launch surfaces, and a read
the gateway withholds from a role (TLS inventory and trust bundles below
`operator`, the audit log below `admin`) must be an explicit `403` naming the
role. `ReadStateNotice` and the TLS page show such a `403` as a denial
(`ReadDeniedNotice`), never as an empty list or a missing feature.

Not checked: `file`, `dp`, `mesh`, and `node_agent` modes (no such gateway
runs in CI), the failover-topology gate, and any Edge release other than the
supported one. When the Edge pin moves, the contract re-runs against the new
image; a disagreement is a model change to review against ferrum-edge
`src/admin/mod.rs`, not a probe to relax. `bffSettings` never reaches the
gateway and is covered by the BFF's own tests.

## Reproducing locally

`scripts/mock-admin-gateway.mjs` reports the configured mode and enforces the
matching refusals, including `/admin/tls/*` writes but not rotate and validate,
so both kinds of denial can be reproduced without a gateway build:

```bash
# read-only admin API: /health reports file mode, config and managed TLS
# writes return 403, rotate and validate still work
MOCK_GATEWAY_MODE=file node scripts/mock-admin-gateway.mjs

# viewer session: the BFF signs a viewer JWT
FERRUM_JWT_ROLE=viewer npm run dev
```
