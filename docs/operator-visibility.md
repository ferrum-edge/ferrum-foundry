# Operator visibility

## Health and audit evidence

Health Status and Audit Log share one authenticated `/health` query, read
through the Foundry BFF, and the same Admin audit pipeline card. Both refresh
health every 30 seconds while open. The cache is keyed by the request
namespace, but process-wide health contents are not namespace-local.

Audit collection counts as disabled only when a fresh, successful health
snapshot either reports `audit_pipeline.enabled: false` or is a detailed
snapshot (it carries `mode`, `timestamp`, `admin_writes_enabled`, and
`cached_config`) that omits `audit_pipeline`. Minimal health, loading, a
pending refresh, a stale snapshot, or a failed read leaves collection unknown.
A valid HTTP 503 readiness snapshot is still a health observation; a BFF error
or an invalid body is not.

When collection is disabled, the Audit Log names `FERRUM_ADMIN_AUDIT_ENABLED`.
Stored historical records can still exist. Keep these limits in mind:

- An empty list describes only the selected namespace, filter, and page.
- Enabled collection does not mean every mutation already appears: delivery
  can lag, and policy can allow unaudited writes.
- `available: false` with `policy: fail_closed` means audited mutations are
  refused with HTTP 503 before they run. With `fail_open`, they proceed and
  can leave an audit gap.
- Sticky `degraded` and `evidence_lost` are separate from current availability.

Health Status shows a card for each section the gateway supplies: gateway
listeners (including truncated/overflowed bounds), sticky serving-listener
failures, database polling backoff and the config-change watcher, per-sink
process logging, plugin log record loss, Kafka logging, AI transcript audit,
remote JWKS freshness, namespace serving scope, service discovery, CP/DP
verification trust, data plane configuration, shared replay authority, and
mesh runtime health (config stream and waypoint state).

Missing sections are not shown as healthy zeroes. Counters are historical, so
a recovered sink can still show earlier loss. Known adverse details raise a
prominent notice even when the coarse process status is `ok`. Scope exclusions
and policy denies on their own do not indicate an outage.

## Proxy-bound API specs

Upstream, `GET /api-specs/by-proxy/{proxy_id}` returns **one raw document**,
or `404 {"error":"API spec not found"}`. It requires admin, carries no spec
UUID or metadata, and `(namespace, proxy_id)` is unique.

The proxy detail page's Bound API specs card therefore works in two steps:

- `apiSpecs.listByProxy(scope, proxyId)` reads metadata from
  `GET /api-specs?proxy_id=...`, checks there is at most one binding, and keeps
  the spec `id` separate from `proxy_id`. The card links to
  `/api-specs?spec=<spec-id>`, which opens the searchable spec list at that ID.
- **View bound document** calls the by-proxy endpoint through
  `apiSpecs.getDocumentByProxy`, requesting YAML. Known non-admin roles see why
  they cannot open the raw document. A missing binding is reported separately
  from authorization, connectivity, and other failures.

Query keys are `['apiSpecs', namespace, 'byProxy', proxyId]` for the summary
and `['apiSpecDocument', namespace, 'byProxy', proxyId]` for the document.
Existing spec and proxy cascade invalidation covers both prefixes. The card
sits inside the identity-keyed proxy editor, so switching namespace or proxy
discards it and a late response for the previous proxy is never shown. The
binding is stored metadata, not a comparison with live routes.

## Mesh Runtime

The Mesh Runtime tab reads `GET /mesh/runtime-overlay`. It returns the
connected workload's **last proxy-accepted slice**:
`{namespace, version, runtime_overlay: {fields?: {...}}}`. It is not a fleet
node list and has no node ID.

Each value keeps its upstream `kind`: `number`, `string`, `bool`, or
`fractional_percent` (a `numerator` with a `hundred`, `ten_thousand`, or
`million` denominator). Fractional percentages show the raw numerator and a
percentage capped at 100%.

| Response | Meaning |
| --- | --- |
| `200` with `runtime_overlay: {}` or `fields: {}` | An accepted slice with no runtime fields. |
| `404 {"error":"No active mesh runtime overlay"}` | Not in mesh mode, or no slice accepted yet. |
| `503` | Temporarily unavailable; current state unknown. |
| Anything else, including 401/403 and malformed bodies | A failure, never an empty overlay. |

Mesh reads use the silent-probe pattern, so expected 404/503 responses do not
raise error popups. The query key includes the request namespace, even though
the response describes the connected process, to keep authorization and
late-response isolation per namespace.

## Mock gateway

`scripts/mock-admin-gateway.mjs` follows these response shapes, filters spec
and audit reads by namespace, and serves a populated runtime overlay when
`MOCK_GATEWAY_MODE=mesh`. Its ordinary audit collection is disabled; seeded
historical audit rows stay readable.
