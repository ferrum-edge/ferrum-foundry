# Alloy service manifest preview

The unreleased Settings → Alloy Service Manifest card consumes the JSON data
model of `ferrum.service_manifest` v1. It calls the authenticated BFF endpoint
`POST /api/service-manifest/preview`; it never calls the gateway from the browser.
Paste JSON matching the shared fixtures. This version does not parse the
producer's TOML source, download a manifest URL, or load an OpenAPI file.

Viewers, operators and administrators may preview within their existing session
grants. The request carries the active tab's `X-Ferrum-Namespace` and ordinary
CSRF token. The BFF authenticates and authorizes the header before parsing, then
requires `gateway.namespace` to equal that binding. An omitted namespace means
the contract default `ferrum`, not the active namespace. Neither the manifest nor
`agents.namespace` grants access; the latter is an MCP tool prefix. Namespace
switches clear the draft and result and abort an outstanding preview.

## Contract and provenance

The canonical pin is `contracts/ferrum-contracts/PIN`: immutable tag
[`contracts-edge-0.9.9-r2`](https://github.com/ferrum-edge/ferrum-contracts/tree/591c73a3f965fdab440c3a76b2707accdf491ba5)
at `591c73a3f965fdab440c3a76b2707accdf491ba5`. The adopted files are the existing
plugin/provisioning vocabularies and schemas, plus the service-manifest schema
and every shared valid/invalid manifest fixture, including agents. Each exact
published file has a SHA-256 in the same pin. The four older files are byte
identical; their original provenance and plugin invariants remain intact. The
contracts revision maps to the previously qualified Edge v0.9.10 release.
The v0.5.0 / Edge v0.9.11 draft keeps these exact immutable bytes while
[canonical PR #13](https://github.com/ferrum-edge/ferrum-contracts/pull/13)
awaits Alloy replacement main CI and root's qualified merge/tag. Its final
published service-manifest wire schema will be unchanged and retain full
descriptions; this draft claims no future tag, bytes, provenance or status.
Canonical pin adoption is a later serial qualification step.

The independently reviewed producer is Alloy commit
[`690aed7a9fa8458aeea4ac8416170c8daeb0470b`](https://github.com/ferrum-edge/ferrum-alloy/tree/690aed7a9fa8458aeea4ac8416170c8daeb0470b).
Foundry reads its `manifest.rs` normalization rules and `export.rs` field mapping.
The shared schema records its earlier transcription source
`4cba0f4a66f85bcee3140e3b92e299275a2507fb`; that published provenance is preserved,
not replaced with the newer producer SHA. The schema's status remains
**PROPOSED**. Foundry's fixture consumption is evidence for one consumer, not a
freeze of v1 or evidence that every Ferrum consumer works.

## What the result means

| Manifest fields | Read-only review output |
| --- | --- |
| `service.name`, `gateway.proxy_id`, `gateway.namespace` | Proxy identity and namespace; ID defaults to service name. |
| `api.public_path`, `service_base_path`, `strip_public_path` | `listen_path`, optional `backend_path` without its trailing slash, `strip_listen_path`. |
| `upstream.host`, `port`, `scheme` | Direct `backend_host`/`backend_port` and `backend_scheme`, or an upstream target when health is present. No `backend_protocol`. |
| `health`, `timeouts` | Presence-based `health_checks.active` with HTTP probe fields; `backend_*_timeout_ms`. Read timeout `0` survives. |
| `gateway.correlation_id`, `otel_endpoint`, sampling ratio | Desired proxy-scoped `correlation_id`/`otel_tracing` configurations and references, with untrusted trace context and URL-path capture off. No telemetry is sent or imported. |
| TLS paths | Literal Edge field names with redacted metadata markers, on the upstream when health is present. No file read, resolution, key import, or runtime TLS qualification. |
| `protocols`, `auth.mode`, `api.openapi`, `agents` | Informational summary only. No auth policy, spec, MCP catalog or tools are installed. OpenAPI path values are omitted. |

The BFF validates the closed shared schema using the existing Zod dependency,
without coercion or silently dropping unknown keys. Defaults come from the
vendored schema. It fails startup if the schema adds an unsupported keyword.
The reviewed producer adds stricter literal path rules (no dot segments,
percent escapes, semicolons or backslashes), derived resource IDs at most 254
characters, and an agents endpoint below the public prefix. These are checked
after validation. Unknown `schemaMajor` is rejected; the version field is
`schema_version` and only major 1 is supported.

Local presentation limits are 32 KiB raw UTF-8 JSON, eight nesting levels before
JSON parsing, 2,048 characters per string, 32 array items, and 16 KiB serialized
output. Integers must be safe JavaScript integers. Control characters and OTLP
URLs with credentials, a query or fragment are refused. These are a narrower
preview envelope, not edits to the shared schema. Errors are fixed, bounded
messages without submitted keys, values or parser excerpts. The BFF does not
log bodies or raw preview queries; the browser replaces request-bearing errors
with safe messages and keeps drafts only in component memory, never storage or
a mutation cache.

Manifest request loggers are installed through Fastify 5's `childLoggerFactory`
at app construction, before incoming-request logging and authentication. Their
request projection names only the preview endpoint; response/error projections
keep a checked numeric HTTP status, and log messages are fixed. This also covers
unauthenticated requests, query credentials, percent-encoded prefixes, parser
and body-limit failures. `frameworkErrors` returns a bounded, non-cacheable
answer for malformed manifest URLs that bypass route hooks. The browser carries
only the HTTP status out of its catch block: the replacement error retains no
request, options, response, parsed data, submitted body or raw cause.

The result is not an import payload: TLS markers must never be applied. Compare
the desired fields in the current Proxies, Upstreams and Plugins editors and
review auth/TLS/MCP policy separately. Ordinary explicitly approved saves still
use the existing capabilities, namespace binding, full-replacement write guards,
secret redaction and live-apply reporting. Preview does not read current gateway
resources, claim drift, test reachability, persist a plan, or enable an apply
action. A refusal produces no desired result; a lost answer means preview is
unavailable, never an unknown gateway write.

## Hosted evidence and remaining consumers

Quality Gate (including Node 24) runs all 12 shared fixtures through the actual
registered BFF route, plus authentication, CSRF, namespace/agents denial,
unknown-key/major, normalization, redaction, bounded input, literal mapping and
accessible UI/cancellation tests. No upstream request is allowed in those
route tests. PIN tests check integrity, complete file coverage, original
vocabulary bytes and the Edge release mapping.

Pinned Gateway Contract separately calls preview as a viewer, compares gateway
collections before and after, then explicitly submits two returned **HTTP**
graphs (direct and active-health) to the disposable qualified gateway. It checks
stored proxy, upstream and plugin fields and cleans up. This is gateway admission
evidence for the HTTP mapping, not TLS deployment qualification or a production
apply path. Deployment Starter and Container Gate include the fixed vendored
schema in the production image.

[Alloy issue 27](https://github.com/ferrum-edge/ferrum-alloy/issues/27) continues to
track Nexus manifest consumption, Anvil diagnostic import and cross-repo checks,
and GitForgeOps validation. This Foundry portion must not close that issue or
mark the shared contract EXISTING without the other consumers' evidence.
The [presentation-boundary ADR](adr/0001-alloy-authenticated-presentation.md)
separates this implemented preview from future diagnostic presentation.
