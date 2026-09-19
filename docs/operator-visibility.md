# Operator visibility

Health Status and Audit Log share the authenticated `/health` query and the
same admin audit pipeline card. All requests use the Foundry BFF. These views
refresh health every 30 seconds while mounted. Their cache is keyed by the
namespace used to authorize the read; process-wide health is not a promise that
its contents are namespace-local.

Only a fresh, successful detailed health snapshot can prove ordinary mutation
collection disabled by omitting `audit_pipeline`. The detailed tier always
includes `mode`, `timestamp`, `admin_writes_enabled`, and `cached_config`.
Minimal health, loading, a pending refresh, an expired observation, and failed
reads conclude nothing about collection. A valid readiness HTTP 503 snapshot
is still a health observation; a BFF error or invalid body is not.

The Audit Log names `FERRUM_ADMIN_AUDIT_ENABLED` when collection is disabled.
Stored historical records can still exist. An empty list describes only the
selected namespace, filter, and page. Enabled collection is not a guarantee
that every mutation already appears: delivery can lag, and policy can permit
unaudited writes. `available: false` with `policy: fail_closed` explains the
pre-mutation HTTP 503 refusal; `fail_open` instead permits an audit gap. Sticky
`degraded` and `evidence_lost` remain distinct from current availability.

Health cards show dynamic listener realization and its truncated/overflowed
bounds separately from sticky serving-task exits. They expose polling backoff
and the optional change watcher, per-sink logging, record loss, Kafka and AI
transcript audit, remote JWKS freshness, namespace serving scope, mesh stream
and waypoint state, discovery, CP/DP trust, DP configuration freshness, and
shared replay authority when supplied. Missing sections are not synthesized
as healthy zeroes. Counters are explicitly historical; recovered sinks can
have prior loss. Known adverse details add a prominent notice even if the
coarse process status is `ok`. Scope exclusions and policy denies alone do not
prove a runtime outage.

## Proxy-bound API specs

The upstream contract differs from the issue's proposed list shape:
`GET /api-specs/by-proxy/{proxy_id}` returns **one raw document**, or
`404 {"error":"API spec not found"}`. It requires admin and has no spec UUID
metadata envelope. `(namespace, proxy_id)` is unique.

`apiSpecs.listByProxy(scope, proxyId)` therefore uses the supported
`GET /api-specs?proxy_id=...` summary filter, validates the zero-or-one binding,
and keeps the returned spec `id` distinct from `proxy_id`. The proxy detail
card links to `/api-specs?spec=<spec-id>`, opening the existing searchable list
at that UUID. Its “View bound document” action calls the actual by-proxy
endpoint through `getDocumentByProxy`, negotiating YAML. Known non-admin roles
see the reason the raw document cannot be opened. A documented missing binding
is distinguished from authorization, connectivity, and other failures.

Summary keys are `['apiSpecs', namespace, 'byProxy', proxyId]`; document keys
are `['apiSpecDocument', namespace, 'byProxy', proxyId]`. Existing spec/proxy
cascade invalidation and retirement cover these prefixes. The card lives in
the existing identity-keyed proxy editor, so a namespace or proxy route switch
retires its view and cannot display a late response from the prior identity.
The binding is not a live-route diff or a claim of spec/config convergence.

## Mesh Runtime

The Runtime tab uses `GET /mesh/runtime-overlay`, which reports the connected
workload's **last proxy-accepted slice**:
`{namespace, version, runtime_overlay: {fields?: {...}}}`. It is not a fleet
node list and returns no node ID. Values retain their upstream tags: `number`,
`string`, `bool`, and `fractional_percent` (`numerator` plus `hundred`,
`ten_thousand`, or `million` denominator). The displayed percentage uses the
upstream consumer's saturation at 100%, alongside the unmodified numerator.

An accepted empty overlay (`runtime_overlay: {}` or `fields: {}`) is distinct
from `404 {"error":"No active mesh runtime overlay"}` (outside mesh mode or
before any accepted slice). HTTP 503 is temporarily unavailable, with current
state unknown. Other errors, including authorization and malformed payloads,
are failures rather than empty overlays. The existing `mesh/` silent-probe
pattern suppresses expected 404/503 popups. The query key includes the request
namespace even though the response describes the connected process, preserving
namespace authorization and late-response isolation.

The mock gateway follows these response shapes, filters spec and audit reads
by namespace, and serves a populated runtime overlay for `MOCK_GATEWAY_MODE=mesh`.
Its ordinary audit collection is disabled; seeded historical audit rows remain
readable. Behavioral/API tests cover these surfaces through the fetch boundary.
They must run in GitHub-hosted CI; no local execution was used for this change.

Contracts were checked against Ferrum Edge's canonical OpenAPI and serializers
at reviewed main `9cd539828ac963adc4eb18b2cacad3e456c1e5db`, especially
`src/admin/mod.rs`, `src/admin/audit.rs`, `src/admin/api_specs/handlers.rs`,
`src/modes/mesh/config.rs`, and subsystem health snapshot serializers. No local
copy of the upstream OpenAPI is stored in Foundry.
