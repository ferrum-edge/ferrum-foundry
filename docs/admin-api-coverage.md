# Admin API coverage

Which Ferrum Edge admin API operations Foundry uses, which its BFF forwards
without using, and which it refuses. The table covers every operation (path and
method) in Edge's `openapi.yaml` at the pinned release, Ferrum Edge v0.9.21
(`edge.source_commit` in [`compatibility.json`](compatibility.json)): 75 paths,
118 operations. See [Supported pairing](compatibility.md) for the pin itself.

<!-- admin-api-coverage source_commit=f9915358c8032214f4034a17c28cdf72d14006c3 spec_sha256=13c21d12d3028c8044ad2f467cbca6425d9bd2f3fce787d6fe7ae78316c21bee paths=75 operations=118 -->

## How to read it

The browser never calls Edge. Every gateway request goes through the BFF's
`/api/proxy/*` route, which signs it with the session's identity (see
[authentication](authentication.md)).

**Foundry** is one of three classes:

- **UI**: the Foundry UI calls it. The cell names the API module (and page).
- **Unused**: nothing in Foundry calls it. The BFF still forwards it for a
  session without namespace grants, because the proxy is transparent for an
  unrestricted session and Edge enforces the role. It is not part of Foundry's
  supported surface: no page, test or compatibility promise covers it.
- **Denied**: the BFF refuses it for every session and role, before capacity
  admission, JWT signing or any upstream request, and Foundry deliberately does
  not expose it.

There is no separate "not exposed" class: for an unrestricted session, an
operation Foundry does not deny is reachable through the BFF, so it is either
used (UI) or listed as Unused.

**Scoped session** says whether a session holding namespace grants may reach
it through the BFF's namespace route ceiling (`server/proxy-path.ts`):
**Allowed** (a namespace-scoped route naming one of the session's grants, or
one of Edge's `ns`-claim global routes) or **Refused** (`403 Namespace access
denied`). The ceiling is an allow-list of route classes (a method set and a
path pattern, such as `GET`, `PUT` and `DELETE` on any namespace-scoped
resource item), not of individual operations, so a class Foundry uses can
admit an operation it does not: `GET /gateway-trust-bundles/{id}` is Unused
but Allowed. Edge's namespace-scoped `GET /config/export`,
`GET /backend-egress-policy` and `POST /batch` were removed from the ceiling
because Foundry uses none of them, and are refused to a scoped session.

Mode-dependent operations (mesh, waypoints, charges, backend capabilities,
gateway trust, audit, API specs) answer `404`/`503` on gateways without the
feature; the pages render that as an empty or unavailable state. The table
says nothing about which gateway modes are qualified: see
[Not qualified](compatibility.md#not-qualified).

## How the table is checked

- `scripts/admin-api-coverage.test.mjs` (Quality Gate, `npm test`) fails when
  a row is malformed or duplicated, when the marker above does not record the
  pinned `edge.source_commit`, when a row's Scoped session or Denied class
  disagrees with `server/proxy-path.ts`, or when a UI row names a source file
  that does not exist. Moving the Edge pin fails it until this table is
  re-checked.
- `npm run check:admin-api-coverage` (`scripts/admin-api-coverage.mjs`,
  Pinned Gateway Contract) fetches `openapi.yaml` at `edge.source_commit`,
  checks the SHA-256 and counts recorded above, and fails when the spec has an
  operation the table lacks or the table lists one the spec does not.

When the pin moves, classify every new operation, remove retired ones, and
update the marker. A new Edge route is refused to scoped sessions until
`server/proxy-path.ts` classifies it.

## Coverage table

### Health

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/live` | Unused | Allowed | Edge liveness probe. The BFF serves its own `/api/health/live` without calling it. |
| `GET` | `/health` | UI | Allowed | `src/api/metrics.ts` (Status page, capability snapshot); the BFF readiness probe and settings status also call it (`server/routes/health.ts`, `server/routes/settings.ts`). Scoped answers are reduced to summary fields. |
| `GET` | `/status` | Unused | Allowed | Not read by the UI. Scoped answers are reduced to summary fields like `/health`. |

### Resources

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/proxies` | UI | Allowed | `src/api/proxies.ts`. |
| `POST` | `/proxies` | UI | Allowed | `src/api/proxies.ts`. |
| `GET` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |
| `PUT` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |
| `DELETE` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |
| `GET` | `/proxies/{id}/mcp/tools` | UI | Allowed | `src/api/mcpTools.ts` (proxy MCP Tools tab). |
| `GET` | `/consumers` | UI | Allowed | `src/api/consumers.ts`. |
| `POST` | `/consumers` | UI | Allowed | `src/api/consumers.ts`. |
| `GET` | `/consumers/{id}/verification` | Denied | Refused | Credential-complete reconciliation read. Refused to every session with `403 FERRUM_BFF_CREDENTIAL_READ_DENIED`. |
| `GET` | `/consumers/{id}` | UI | Allowed | `src/api/consumers.ts`. |
| `PUT` | `/consumers/{id}` | UI | Allowed | `src/api/consumers.ts`. |
| `DELETE` | `/consumers/{id}` | UI | Allowed | `src/api/consumers.ts`. |
| `PUT` | `/consumers/{consumer_id}/credentials/{cred_type}` | UI | Allowed | `src/api/consumers.ts`. |
| `POST` | `/consumers/{consumer_id}/credentials/{cred_type}` | UI | Allowed | `src/api/consumers.ts`. |
| `DELETE` | `/consumers/{consumer_id}/credentials/{cred_type}` | UI | Allowed | `src/api/consumers.ts`. |
| `DELETE` | `/consumers/{consumer_id}/credentials/{cred_type}/{index}` | UI | Allowed | `src/api/consumers.ts`. |
| `GET` | `/plugins` | UI | Allowed | `src/api/plugins.ts` (plugin picker). |
| `GET` | `/plugins/config` | UI | Allowed | `src/api/plugins.ts`. |
| `POST` | `/plugins/config` | UI | Allowed | `src/api/plugins.ts`. |
| `GET` | `/plugins/config/{id}` | UI | Allowed | `src/api/plugins.ts`. |
| `PUT` | `/plugins/config/{id}` | UI | Allowed | `src/api/plugins.ts`. |
| `DELETE` | `/plugins/config/{id}` | UI | Allowed | `src/api/plugins.ts`. |
| `GET` | `/upstreams` | UI | Allowed | `src/api/upstreams.ts`. |
| `POST` | `/upstreams` | UI | Allowed | `src/api/upstreams.ts`. |
| `GET` | `/upstreams/{id}` | UI | Allowed | `src/api/upstreams.ts`. |
| `PUT` | `/upstreams/{id}` | UI | Allowed | `src/api/upstreams.ts`. |
| `DELETE` | `/upstreams/{id}` | UI | Allowed | `src/api/upstreams.ts`. |
| `GET` | `/gateway-trust-bundles` | UI | Allowed | `src/api/trust.ts` (Mesh, Trust). |
| `POST` | `/gateway-trust-bundles` | UI | Allowed | `src/api/trust.ts` (Mesh, Trust). |
| `GET` | `/gateway-trust-bundles/{id}` | Unused | Allowed | The trust manager edits from the list read; it never reads one bundle. |
| `PUT` | `/gateway-trust-bundles/{id}` | UI | Allowed | `src/api/trust.ts` (Mesh, Trust). |
| `DELETE` | `/gateway-trust-bundles/{id}` | UI | Allowed | `src/api/trust.ts` (Mesh, Trust). |
| `GET` | `/gateway-trust/status` | UI | Allowed | `src/api/trust.ts` (Mesh, Trust). |
| `GET` | `/namespaces` | UI | Allowed | `src/api/namespaces.ts` (Settings, Namespaces). |
| `POST` | `/namespaces` | UI | Allowed | `src/api/namespaces.ts` (Settings, Namespaces). |
| `GET` | `/namespaces/{name}` | UI | Allowed | `src/api/namespaces.ts` (Settings, Namespaces). |
| `PUT` | `/namespaces/{name}` | UI | Allowed | `src/api/namespaces.ts` (Settings, Namespaces). |
| `DELETE` | `/namespaces/{name}` | UI | Allowed | `src/api/namespaces.ts` (Settings, Namespaces). |
| `GET` | `/api-specs` | UI | Allowed | `src/api/apiSpecs.ts`. |
| `POST` | `/api-specs` | UI | Allowed | `src/api/apiSpecs.ts`. |
| `GET` | `/api-specs/{id}` | UI | Allowed | `src/api/apiSpecs.ts`. |
| `PUT` | `/api-specs/{id}` | UI | Allowed | `src/api/apiSpecs.ts`. |
| `DELETE` | `/api-specs/{id}` | UI | Allowed | `src/api/apiSpecs.ts`. |
| `GET` | `/api-specs/by-proxy/{proxy_id}` | UI | Allowed | `src/api/apiSpecs.ts`. |

### Configuration

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/config/export` | Unused | Refused | Foundry exports through `GET /backup` (Settings, Backup). Withheld from scoped sessions (least privilege); forwarded for an unrestricted session. |
| `GET` | `/audit` | UI | Allowed | `src/api/ops.ts` (Audit page). |
| `POST` | `/batch` | Unused | Refused | The editors create resources one at a time. Withheld from scoped sessions (least privilege); forwarded for an unrestricted session. |
| `GET` | `/deployment-snapshot` | Denied | Refused | Secret-complete deployment evidence. Refused to every session with `403 FERRUM_BFF_CREDENTIAL_READ_DENIED`. |
| `GET` | `/backup` | UI | Allowed | `src/api/ops.ts` (Settings, Backup download). |
| `POST` | `/restore` | UI | Allowed | `src/api/ops.ts` (Settings, Restore, with confirmation). |

### Metrics and operations

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/overload` | UI | Refused | `src/api/ops.ts` (Metrics page). Fleet-global. |
| `GET` | `/metrics` | UI | Refused | `src/api/metrics.ts` (Metrics page, per-route metrics). Fleet-global. |
| `GET` | `/metrics/runtime` | UI | Refused | `src/api/ops.ts` (Metrics page). Fleet-global. |
| `GET` | `/charges` | UI | Refused | `src/api/ops.ts` (Metrics page, API Chargeback). Fleet-global. |
| `GET` | `/charges/sink/status` | UI | Refused | `src/api/ops.ts` (Metrics page, Chargeback Sink Delivery; read-only). Fleet-global. |
| `GET` | `/admin/metrics` | UI | Refused | `src/api/metrics.ts` (Metrics page, Dashboard). Fleet-global. |
| `GET` | `/config/apply-status` | UI | Refused | `src/api/client.ts` (live-apply poll after a committed write). Scoped sessions do not poll it. |
| `GET` | `/cluster` | UI | Refused | `src/api/ops.ts` (Cluster page). Fleet-global. |
| `GET` | `/backend-egress-policy` | Unused | Refused | Not read; the Cluster page shows the per-data-plane reports from `GET /cluster`. Withheld from scoped sessions (least privilege). |
| `GET` | `/backend-capabilities` | UI | Refused | `src/api/ops.ts` (Cluster page). Fleet-global. |
| `POST` | `/backend-capabilities/refresh` | UI | Refused | `src/api/ops.ts` (Cluster page, operator). Fleet-global. |
| `GET` | `/diagnostics/v1/refs/{ref}` | Unused | Refused | No diagnostic-reference import exists in Foundry. Fleet-global. |

### Mesh

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/node-waypoint/identities` | UI | Refused | `src/api/mesh.ts` (Mesh page, Waypoints). Fleet-global. |
| `GET` | `/service-waypoint/services` | UI | Refused | `src/api/mesh.ts` (Mesh page, Waypoints). Fleet-global. |
| `GET` | `/mesh/service-graph` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/egress-scope` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `POST` | `/mesh/egress-scope/test` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/federation` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/remote-clusters` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/runtime-overlay` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/config-drift` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `GET` | `/mesh/slice-drift` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |
| `POST` | `/mesh/config-revision/reset` | Denied | Refused | Break-glass reset of a data plane's fail-closed revision guard. Refused to every session with `403 FERRUM_BFF_ROUTE_NOT_EXPOSED`; see [below](#mesh-config-revision-reset). |
| `GET` | `/mesh/policy-denies/recent` | UI | Refused | `src/api/mesh.ts` (Mesh page). Fleet-global. |

### TLS

| Method | Path | Foundry | Scoped session | Where or why |
| --- | --- | --- | --- | --- |
| `GET` | `/admin/tls/inventory` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/events` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/acme/certificates` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/acme/certificates` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/acme/certificates/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `PUT` | `/admin/tls/acme/certificates/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `DELETE` | `/admin/tls/acme/certificates/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/acme/orders` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/acme/orders` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/acme/accounts` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/acme/renew/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/acme/orders/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `DELETE` | `/admin/tls/acme/orders/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/acme/orders/{id}/finalize` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/certificates` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/certificates` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/certificates/{id}` | Unused | Refused | The list read returns the same record; the TLS page never needs one record on its own. Fleet-global. |
| `PUT` | `/admin/tls/certificates/{id}` | UI | Refused | `src/api/tls.ts` (TLS page, Rotate: in-place replacement, the only way to change a referenced record). Fleet-global. |
| `DELETE` | `/admin/tls/certificates/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/ca-bundles` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/ca-bundles` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/ca-bundles/{id}` | Unused | Refused | The list read returns the same record; the TLS page never needs one record on its own. Fleet-global. |
| `PUT` | `/admin/tls/ca-bundles/{id}` | UI | Refused | `src/api/tls.ts` (TLS page, Rotate: in-place replacement, the only way to change a referenced record). Fleet-global. |
| `DELETE` | `/admin/tls/ca-bundles/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/crls` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/crls` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/crls/{id}` | Unused | Refused | The list read returns the same record; the TLS page never needs one record on its own. Fleet-global. |
| `PUT` | `/admin/tls/crls/{id}` | UI | Refused | `src/api/tls.ts` (TLS page, Rotate: in-place replacement, the only way to change a referenced record). Fleet-global. |
| `DELETE` | `/admin/tls/crls/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/ocsp-responses` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/ocsp-responses` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/ocsp-responses/{id}` | Unused | Refused | The list read returns the same record; the TLS page never needs one record on its own. Fleet-global. |
| `PUT` | `/admin/tls/ocsp-responses/{id}` | UI | Refused | `src/api/tls.ts` (TLS page, Rotate: in-place replacement, the only way to change a referenced record). Fleet-global. |
| `DELETE` | `/admin/tls/ocsp-responses/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/jwks` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/jwks` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `GET` | `/admin/tls/jwks/{id}` | Unused | Refused | The list read returns the same record; the TLS page never needs one record on its own. Fleet-global. |
| `PUT` | `/admin/tls/jwks/{id}` | UI | Refused | `src/api/tls.ts` (TLS page, Rotate: in-place replacement, the only way to change a referenced record). Fleet-global. |
| `DELETE` | `/admin/tls/jwks/{id}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/rotate/{surface}` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |
| `POST` | `/admin/tls/validate` | UI | Refused | `src/api/tls.ts` (TLS page). Fleet-global. |

## Decisions

### Chargeback sink status

`GET /charges/sink/status` reports `api_chargeback_sink` delivery: per-instance
queue, spool and export state for each accepted plugin configuration, and
process-lifetime totals of exports, drops, dead letters and unbound spool
records. It is read-only, readable by every admin role, and fleet-global, like
`GET /charges`. The Metrics page shows it in a **Chargeback Sink Delivery**
panel beside API Chargeback (`ChargebackSinkPanel` in
`src/components/metrics/OpsPanels.tsx`). The page is withheld from scoped
sessions (`FleetViewGate`), as the BFF and Edge refuse the route to them. Edge
renders the ClickHouse endpoint as `scheme://host:port/redacted`, so the panel
shows no credential, path or query.

### Mesh config revision reset

`POST /mesh/config-revision/reset?confirm=true` (Edge: `operator` role, mesh
mode only) clears a mesh data plane's accepted config revision so the next
slice from any authority is eligible. It lowers the fail-closed guard that stops
a lagging control plane from rolling the data plane back, and is Edge's
documented recovery for one case: a config store restored from backup without
bumping the config authority id. Edge recommends bumping
`FERRUM_MESH_CONFIG_AUTHORITY_ID` (or `FERRUM_MESH_CONFIG_K8S_AUTHORITY_ID`)
fleet-wide where possible.

Foundry does not expose it, and the BFF refuses it to every session with
`403 FERRUM_BFF_ROUTE_NOT_EXPOSED`:

- Foundry's mesh pages are read-only observability. The only mesh `POST` it
  sends, `POST /mesh/egress-scope/test`, is a stateless dry run. Mesh
  configuration belongs to mesh policy sources, not to Foundry.
- Mesh mode is not a qualified Foundry mode, and no Foundry gate can exercise
  the reset (Edge answers `404` outside mesh mode).
- It acts on the one data plane Foundry's BFF targets, while the usual
  recovery is a fleet-wide authority id change.

Operators who need it call the Edge admin API directly with their own
`operator` token; Edge requires `?confirm=true` and records an audit event.

### Unused operations

- `GET /config/export` and `POST /batch` are namespace-scoped Edge routes that
  Foundry does not call: it exports through `GET /backup` and creates
  resources one at a time. They were removed from the BFF's namespace route
  ceiling (least privilege), as was the equally unused
  `GET /backend-egress-policy`. An unrestricted session can still reach them
  through the transparent proxy; they carry no Foundry compatibility promise.
- `GET /live`, `GET /status`, `GET /gateway-trust-bundles/{id}`, and `GET` of
  one managed TLS record are reads Foundry does not need: its own
  `/api/health` endpoints are the probes, the Status page reads `/health`, and
  the list reads already return each bundle and record. `GET /gateway-trust-bundles/{id}` stays inside the ceiling's resource
  item class: it reads one bundle of a granted namespace, which the session
  can already read through the list Foundry uses, so it grants nothing new,
  and narrowing the class would only split one route pattern for no gain. `GET /diagnostics/v1/refs/{ref}` is unused because Foundry has no
  diagnostic-reference import.
- `GET /consumers/{id}/verification` and `GET /deployment-snapshot` return
  credential-complete evidence and are denied; see
  [authentication](authentication.md#credential-complete-reconciliation-reads).
