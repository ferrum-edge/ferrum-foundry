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
| `role` | `principal.role` on the Foundry session (`GET /api/auth/session`) — `viewer`, `operator`, or `admin`. Validated with `isGatewayRole()` at the provider boundary, so an off-enum role from the network is `null` rather than a silent comparison against `undefined` |
| `mode` | `mode` on the authenticated gateway health snapshot (`GET /health`) |
| `adminWritesEnabled` | `admin_writes_enabled` on the same snapshot |
| `status` | `status` on the same snapshot (`ok` / `degraded` / `starting` / `unavailable` / `draining`) |

`CapabilityProvider` reads one health snapshot for the whole workspace and only
accepts it while `resolveReadState` says `loaded`. A stale or failed read
contributes nothing new.

The **last snapshot that loaded is retained for the life of the provider**. A
gateway's mode and its write policy are fixed at start-up, so a past observation
of them stays true for the session, and a failing background refetch — `useHealth`
has `staleTime: 30_000` and refetches on window focus — must not flip a form
from read-only to editable and back. Until some read has loaded, both facts are
`null`.

## Read truthfulness

A fact that has not been read is `null` and concludes nothing. An unknown role
or an unread health snapshot leaves every surface **enabled** and lets the
server answer, which is also what `useCapabilities()` returns outside a
provider. Only a positively observed denial renders a surface read-only, so the
UI never invents an authorization conclusion from a failed read.

## Gateway write gates

Ferrum Edge admits a mutation through one of three paths, and they are not
interchangeable. Each Foundry surface names the one it mirrors.

| Gate | Upstream admission | What denies it |
| --- | --- | --- |
| `config-store` | `AdminState::admit_write`, reported as `admin_writes_enabled` = `!admin_writes_currently_blocked()` (`src/admin/mod.rs:499`) | a read-only mode, an unavailable configuration database, **or** a failover topology without `FERRUM_DB_FAILOVER_ALLOW_WRITES=true` |
| `read-only-mode` | `AdminState::admit_non_config_db_write` (`src/admin/mod.rs:813`) — the read-only gate plus the DB-availability gate, and deliberately **not** the sticky config-DB failover gate | a read-only mode |
| `none` | no write gate — reads, and `admit_audited_operation` (`src/admin/mod.rs:832`), which participates only in the audit handoff | nothing the UI can observe |

`resolveReadOnlyModeState()` classifies the first of those; `resolveGatewayWriteState()`
runs it first and then falls back to `admin_writes_enabled`:

| Observation | `read-only-mode` | `config-store` |
| --- | --- | --- |
| `mode` is `file`, `dp`, `mesh`, or `node_agent` | `read-only` | `read-only` |
| not a read-only mode, `admin_writes_enabled === false`, observed `status !== "degraded"` | `read-only` | `read-only` |
| `admin_writes_enabled === false` (`status` unread or `"degraded"`) | `unknown` | `read-only` |
| `admin_writes_enabled === true` | `unknown` | `enabled` |
| neither observed | `unknown` | `unknown` |

The mode check runs first because it names a cause the operator can act on.
Those four modes set `read_only: true` unconditionally (`src/modes/file.rs:1092`,
`data_plane.rs:790`, `mesh/mod.rs:16015`, `node_agent.rs:1275`); `database` and
`cp` take the same flag from `FERRUM_ADMIN_READ_ONLY` (`database.rs:2078`,
`control_plane.rs:2439`), which the mode string cannot reveal.

On those writable modes the flag is still observable. `handle_health` forces
`status: "degraded"` when writes are blocked **and** the process is not
read-only (`src/admin/mod.rs:2823-2826`). The OpenAPI `HealthResponse` schema
states the same split: intentional read-only mode does **not** set `degraded`,
and `admin_writes_enabled: false` without read-only mode forces `degraded`. So
on a mode that is not in the read-only set, `admin_writes_enabled === false`
together with an observed `status !== "degraded"` is a positive observation of
`FERRUM_ADMIN_READ_ONLY`, and cannot fire on a failover-topology denial (that
path is `status: "degraded"`). An unread `status` still concludes nothing.

A `read-only-mode` surface must **not** be gated on `admin_writes_enabled`
alone: that flag also folds in the failover-topology gate, which does not
reach the independent TLS/ACME stores, so doing so would invent a denial the
gateway does not make.

## Surface matrix

Role requirements follow the upstream contract — `body_consuming_route_role`
(`src/admin/mod.rs:2032`) and `tls_route_required_role` (`src/admin/mod.rs:2087`),
not the prose in `openapi.yaml`. `viewer` reads, `operator` additionally mutates
proxies, upstreams, plugin configs and operational endpoints, and `admin` covers
consumers, credentials, API specs, TLS material, gateway trust, batch/restore,
the namespace registry, and audit.

| Surface | Minimum role | Gate | Upstream admission it mirrors |
| --- | --- | --- | --- |
| `proxies` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /proxies` |
| `upstreams` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /upstreams` |
| `pluginConfigs` | `operator` | `config-store` | `admit_write` on `POST/PUT/DELETE /plugins/config` |
| `operationalActions` (TLS rotate/validate, backend-capability refresh, egress dry-run) | `operator` | `none` | `admit_audited_operation` / no gate |
| `consumers` | `admin` | `config-store` | `admit_write` on `POST/PUT/DELETE /consumers` |
| `consumerCredentials` | `admin` | `config-store` | `admit_write` on `/consumers/{id}/credentials/{type}` |
| `apiSpecs` | `admin` | `config-store` | `admit_write` on `/api-specs` |
| `namespaceRegistry` | `admin` | `config-store` | `admit_write` on `/namespaces` |
| `configBackup` (`POST /restore`) | `admin` | `config-store` | `admit_write` on `/restore` |
| `gatewayTrust` | `admin` | `config-store` | `admit_write` on `/gateway-trust-bundles` |
| `configExport` (`GET /backup`) | `admin` | `none` (denied on `node_agent`) | `handle_backup` — a read, no write gate; `node_agent` has no cached config |
| `tlsMaterial` (certificates, CA bundles, CRLs, OCSP, JWKS, ACME) | `admin` | `read-only-mode` | `admit_non_config_db_write` — all 18 handlers in `src/admin/tls_management.rs` |
| `bffSettings` (`PUT /api/settings`, BFF-local) | `admin` | `none` | `requireRole('admin')` in `server/routes/settings.ts`; never reaches the gateway |

Two entries deserve their reasoning spelled out.

**`tlsMaterial` is `read-only-mode`, not `none`.** Managed TLS and ACME records
live in stores independent of the configuration database, so `admin_writes_enabled`
does not describe them — but every one of their 18 mutation handlers calls
`admit_non_config_db_write`, whose first step is `admit_read_only_gate()`. On a
`file`/`dp`/`mesh`/`node_agent` gateway they return `403 {"error":"Admin API is in
read-only mode"}`. The same refusal applies on `database`/`cp` started with
`FERRUM_ADMIN_READ_ONLY=true`, which the model now observes as writes-disabled
plus a non-`degraded` health status. Rotate and validate are the exemption: they
go through `admit_audited_operation`, which does not apply the read-only gate,
and stay available in every mode.

**`configExport` is `none`, except on `node_agent`.** `GET /backup` is a read.
`handle_backup` (`src/admin/mod.rs:9383`) applies no write gate. `file`, `dp`,
and `mesh` populate `cached_config` (`file.rs:1090`, `data_plane.rs:787`,
`mesh/mod.rs:16012`) and serve that when there is no configuration database.
`node_agent` is the exception: it builds `AdminState { db: None, cached_config:
None }` (`src/modes/node_agent.rs:1269-1275`), so the cached-config branch of
`handle_backup` returns `503 {"error":"Database unavailable and no cached
config"}`. The model observes that mode and denies export there. On every other
read-only mode, export stays available to an admin.

A role denial is reported ahead of a gateway-mode denial: it is the more
fundamental and the more stable of the two.

## Presentation

`src/components/shared/CapabilityGate.tsx` renders the verdict:

- `CapabilityNotice` — the visible reason: the surface's `headline` plus the
  `explanation`. It carries `data-capability-blocked="role" | "gateway-read-only"`.
- `ReadOnlySurface` — the notice plus a `disabled` fieldset around a whole
  editing surface, with `aria-describedby` from the fieldset to the notice.
  It defaults to `display: contents` so layout is unchanged; a caller that
  passes `contentClassName` gets a real box, and `min-w-0` with it, because a
  fieldset inherits the UA `min-width: min-content` that Tailwind preflight
  does not reset.
- `WriteAction` — a single unavailable action with a short visible reason,
  associated with the control through `aria-describedby`. The full explanation
  rides along as visually hidden text, since a disabled control is not
  focusable and the visible summary is only a few words. The child receives
  `disabled: true` via `cloneElement` so a denied button matches the greyed
  controls that pass `disabled` directly (TLS inventory, API spec import).

A disabled control is never the only signal: every read-only surface carries
visible text naming the role or the gateway mode **before** the user edits
anything. `role="status"` on the reason means a denial that resolves *after*
first paint is announced; one already present at first paint is not announced by
a live region, which is why the `aria-describedby` association exists.

`Input`, `Select` triggers, and the form `Checkbox` helpers carry
`disabled:opacity-60 disabled:cursor-not-allowed` so a `fieldset[disabled]`
descendant — which matches `:disabled` — reads as disabled. HTTP-method chip
labels wrap an `sr-only` checkbox, so they use `has-[:disabled]:` to lose
`cursor-pointer` and hover; a `:disabled` variant on the hidden input would not
restyle the label. Native textareas under the fieldset are covered in
`src/styles/globals.css`.

Forms additionally refuse to submit while their capability is denied, so a
programmatic submit cannot slip past the presentation.

### A read-only surface never shows less than the editable one

The `disabled` fieldset covers editing controls. Anything the denied role may
still **read** stays reachable:

- Collapsible sections are forced open. `useCollapsibleFormValidation(sections, readOnly)`
  resolves `open` to `true` for every section, because the section toggle is a
  plain `<button>` that the ancestor fieldset also disables — a section left
  collapsed could never be opened again.
- The **Cancel** button lives outside the fieldset, so there is always an
  in-form way back. Only the submit button is disabled.

## Adding a surface

1. Add the key to `CapabilitySurface` and a descriptor to `SURFACES`. Choose
   `minimumRole` from `body_consuming_route_role` / `tls_route_required_role` in
   ferrum-edge `src/admin/mod.rs` — not from `openapi.yaml` prose — and choose
   `gate` by reading which admission function the handler calls: `admit_write`
   → `config-store`, `admit_non_config_db_write` → `read-only-mode`,
   `admit_audited_operation` or none → `none`. Write the `headline` as a full
   sentence — an editing surface is "read-only", a one-off action is
   "unavailable".
2. Read it with `useCapabilities()` and render `CapabilityNotice`,
   `ReadOnlySurface`, or `WriteAction`.
3. Guard the mutation handler with `if (!capability.allowed) return;`. Guard the
   *mutation*, not the button, when one control serves both a read and a write.
4. Extend `src/lib/capabilities.test.ts` with the new row (the three gate lists
   must still partition `CAPABILITY_SURFACES`), and
   `scripts/mock-admin-gateway.mjs` if the gateway refuses it in a read-only mode.

## Drift

The role/mode matrix is duplicated from ferrum-edge with no automated parity
check. When the upstream admin API changes its roles or its write gates, this
model must be re-read against `src/admin/mod.rs` by hand; nothing in CI catches
the divergence.

## Reproducing locally

`scripts/mock-admin-gateway.mjs` reports the mode and enforces the matching
refusal — including `/admin/tls/*` writes, and excluding rotate and validate —
so both denials can be reproduced without a gateway build:

```bash
# read-only admin API: /health reports file mode, config and managed TLS
# writes return 403, rotate and validate still work
MOCK_GATEWAY_MODE=file node scripts/mock-admin-gateway.mjs

# viewer session: the BFF signs a viewer JWT
FERRUM_JWT_ROLE=viewer npm run dev
```
