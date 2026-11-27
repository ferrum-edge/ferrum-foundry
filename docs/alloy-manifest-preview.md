# Alloy service manifest preview

The Settings → Alloy Service Manifest card consumes the JSON data
model of `ferrum.service_manifest` v1. It calls the authenticated BFF endpoint
`POST /api/service-manifest/preview`; it never calls the gateway from the browser.
Paste JSON matching the shared fixtures. By design for 1.0, the preview does
not parse Alloy's TOML source, download a manifest URL, or load an OpenAPI
file, and it never applies anything (see [What the result means](#what-the-result-means)).

Viewers, operators and administrators may preview within their existing session
grants. The request carries the active tab's `X-Ferrum-Namespace` and ordinary
CSRF token. The BFF authenticates and authorizes the header before parsing, then
requires `gateway.namespace` to equal that binding. An omitted namespace means
the contract default `ferrum`, not the active namespace. Neither the manifest nor
`agents.namespace` grants access; the latter is an MCP tool prefix. Namespace
switches clear the draft and result and abort an outstanding preview.

## Contract and provenance

The canonical pin is `contracts/ferrum-contracts/PIN`: immutable tag
[`contracts-edge-0.9.21`](https://github.com/ferrum-edge/ferrum-contracts/tree/92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f)
at `92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f`. The adopted files are the existing
plugin/provisioning vocabularies and schemas, plus the service-manifest schema
and every shared valid/invalid manifest fixture, including agents, plus the
canonical invalid-expectations file. Each exact published file has a SHA-256 in
the same pin. The invalid expectations include deployment-snapshot,
backend-egress-policy, diagnostic-ref and gateway-headers negatives, but
Foundry does not vendor those schemas or adopt that runtime profile. Release
and qualification evidence is in the [compatibility record](compatibility.md).

The independently reviewed producer is Alloy `main` at commit
[`0e8a96a24c149432f0c3583732d8a3875db756ce`](https://github.com/ferrum-edge/ferrum-alloy/tree/0e8a96a24c149432f0c3583732d8a3875db756ce)
(requalified for #719). Foundry reads its `manifest.rs` normalization rules,
`export.rs` field mapping and the `tests/export.rs` regression tests; that
review is producer evidence. The OTLP endpoint rule follows Ferrum Edge `main`
(see below) where Alloy's differs. Alloy has since been released:
[Ferrum Alloy v0.1.0](https://github.com/ferrum-edge/ferrum-alloy/releases/tag/v0.1.0)
(published 2026-11-21, tag commit `c949978d7e90be33bac6a16e23744bcdd4ee3924`)
contains both the reviewed producer commit and the schema owner commit below.
Foundry has not re-reviewed the producer at that tag.

The published schema separately records its owner, Alloy
`81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e`: shared status **EXISTING**, with
`x-contract.status: implemented`. Its owner `availability` field still reads
`unreleased`; that is the vendored `contracts-edge-0.9.21` metadata, written
before Alloy v0.1.0 was published, and Foundry never edits vendored bytes. The
schema remains a transcription of owner code, with post-default and
cross-field limitations stated in its provenance. It does not establish a
Foundry diagnostic importer.

## What the result means

| Manifest fields | Read-only review output |
| --- | --- |
| `service.name`, `gateway.proxy_id`, `gateway.namespace` | Proxy identity and namespace; ID defaults to service name. |
| `api.public_path`, `service_base_path`, `strip_public_path` | `listen_path`, optional `backend_path` without its trailing slash, `strip_listen_path`. |
| `upstream.host`, `port`, `scheme` | Direct `backend_host`/`backend_port` and `backend_scheme`, or an upstream target when health is present. No `backend_protocol`. |
| `health`, `timeouts` | Presence-based `health_checks.active` with HTTP probe fields; `backend_*_timeout_ms`. Read timeout `0` survives. |
| `gateway.correlation_id` | Desired proxy-scoped `correlation_id` configuration and reference. |
| `gateway.otel_endpoint`, sampling ratio | A proxy-scoped `otel_tracing` configuration and reference for **every** manifest, with untrusted trace context and URL-path capture off, because only that plugin removes a caller's `traceparent`/`tracestate`. With an endpoint it exports there (plus the sampling ratio); without one it is propagation-only (`generate_trace_id: false`, no `endpoint`, ratio ignored) and exports nothing. `summary.traceExporter` (`otlp` or `none`) and the card say which, so "no configured exporter" is never shown as "no plugin". No telemetry is sent or imported. |
| TLS paths | Literal Edge field names with redacted metadata markers, on the upstream when health is present. No file read, resolution, key import, or runtime TLS qualification. |
| `protocols`, `auth.mode`, `api.openapi`, `agents` | Informational summary only. No auth policy, spec, MCP catalog or tools are installed. OpenAPI path values are omitted. `auth.mode: "gateway"` is refused, as Alloy's export refuses it (it cannot generate Edge authentication). |

The BFF validates the closed shared schema using the existing Zod dependency,
without coercion or silently dropping unknown keys. Defaults come from the
vendored schema. If the schema cannot be compiled (for example it adds an
unsupported keyword), only this preview route is disabled: the BFF still
starts, logs the failure once, and the preview route answers `503`.
The reviewed producer adds stricter rules, checked after validation:

- Literal paths are ASCII RFC 3986 `pchar`s and `/` only, minus `;`, `%`, `~`
  and `*`, with no `//` or dot segment (so no non-ASCII, `|`, `"`, `^` or
  backslash either).
- Every derived resource ID is at most 254 characters. The
  `<id>-otel-tracing` plugin is always generated, so with correlation disabled
  and no health check an explicit 241-character `gateway.proxy_id` is accepted
  and 242 is refused; `-correlation-id` binds at 239/240 when correlation is
  on. An ID defaulted from `service.name` is bounded first by that field's
  63-character limit (as in Alloy), so it never reaches the derived-ID limit.
- An agents endpoint below the public prefix.
- `auth.mode: "gateway"` is refused.
- `gateway.otel_endpoint` must be `https://`, or `http://` to a loopback IP
  literal: Ferrum Edge v0.9.19+ drops a cleartext exporter to any other host
  unless `allow_plaintext` is set, and Alloy never writes it. Foundry follows
  Edge `main`'s `otel_tracing` rule (`screen_cleartext_endpoint` and
  `is_loopback_ip_literal_endpoint`, unchanged since v0.9.20): the parsed host
  must be loopback and the written authority `127.d.d.d` (1-3 digit octets) or
  `[::1]`, with an optional all-digit port. As in Edge, the value is judged
  after trimming Unicode whitespace from both ends (Rust `str::trim`), so
  `http://127.0.0.1:4318 ` is accepted; the desired configuration keeps the
  value as Alloy writes it. `localhost`, `127.1`,
  `[::ffff:127.0.0.1]` and the uncompressed `[0:0:0:0:0:0:0:1]` are refused.
  Alloy's own check parses the host as an IP address instead, so it accepts
  `[0:0:0:0:0:0:0:1]` and refuses leading-zero octets such as `127.001.0.1`;
  where they differ, Foundry follows Edge, the runtime that drops the exporter.

Unknown `schemaMajor` is rejected; the version field is `schema_version` and
only major 1 is supported.

The pinned `contracts-edge-0.9.21` schema and fixtures include the cleartext
rule (ferrum-contracts#82): `orders-api.json` and the repaired
`client-cert-without-key.json` use `https://otel-collector:4318/v1/traces`, and
`otel-endpoint-cleartext-non-loopback.json` covers the refused cleartext case.

Edge bounds (ferrum-contracts#74, Alloy `validate()`), as of this pin:

- Enforced by the vendored schema and preview: `api.public_path` at most 500
  characters (bytes, as paths are ASCII-only), `api.service_base_path` at most
  2,049 characters (its stripped trailing `/` leaves a `backend_path` of at most
  2,048 bytes, matching Edge; Alloy `main` currently refuses more than 2,048
  including the slash), `upstream.host` at most 255 code points (excluding ASCII
  space, `/`, `@` and C0 control characters), `health.path` at most 2,048
  characters, `health.interval_seconds` at most 3,600, and `health.timeout_ms`
  and `timeouts.*` at most 86,400,000. The precheck and schema refuse C0 control
  characters (U+0000-U+001F) and DEL (U+007F) in every string, including
  `upstream.host` and `agents.endpoint_path`, and the literal path rule refuses
  `;`, `%`, `\`, `*`, `~` and dot segments.
- Not enforced by the schema or preview alone: Alloy also refuses an
  `upstream.host` containing any Unicode whitespace or control character (for
  example U+00A0 or U+0085, which neither the schema nor the C0/DEL precheck
  refuses), and bounds the host at 255 UTF-8 bytes, so a non-ASCII host of 255
  or fewer code points can still exceed Alloy's limit.

Local presentation limits are 32 KiB raw UTF-8 JSON, eight nesting levels before
JSON parsing, 32 array items, and 16 KiB serialized output. `maxLength` is
supported only on a field's own schema node (the root, a `properties` entry or
`items`, beside `type`, `enum`, `const` or `pattern`). Each such node applies
one bound to string values: its declared `maxLength`, or 2,048 characters when
it declares none. Composition clauses (`allOf`, `anyOf`, `if`/`then`, and
properties declared inside them) add no bound or default; a `maxLength` there,
or one above 4,096, does not compile, so the route answers `503` rather than
silently clamping a bound. Every string value and property name, including
unknown keys refused by the closed schema, is capped at 4,096 characters
before validation. Lengths count Unicode code points, as JSON Schema does.
Integers must be safe JavaScript integers. Control characters and OTLP URLs
with credentials, a query or fragment are refused. These are a narrower
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

Quality Gate (including Node 24) runs all 31 shared fixtures (5 valid, 26 invalid)
through the actual registered BFF route, plus authentication, CSRF, namespace/agents denial,
unknown-key/major, normalization, redaction, bounded input, literal mapping and
accessible UI/cancellation tests. No upstream request is allowed in those
route tests. Canonical invalid expectations cover every negative fixture;
single-defect repair controls verify its declared schema location and keyword
and require the repaired input to pass the registered route. PIN tests check
complete byte integrity (including descriptions), complete file coverage,
vocabulary semantics, owner status and the Edge release mapping.

Pinned Gateway Contract separately calls preview as a viewer, compares gateway
collections before and after, then explicitly submits three returned **HTTP**
graphs (direct, active-health, and direct without an OTLP exporter, whose
`otel_tracing` is propagation-only) to the disposable qualified gateway. It checks
stored proxy, upstream and plugin fields and cleans up. This is gateway admission
evidence for the HTTP mapping, not TLS deployment qualification or a production
apply path. Deployment Starter and Container Gate include the fixed vendored
schema in the production image.

[Alloy issue 27](https://github.com/ferrum-edge/ferrum-alloy/issues/27) tracked
coordinated adoption across Nexus, Anvil, Alloy and GitForgeOps until it closed
on 2026-10-06. The canonical publication records their earlier qualified slices
and the accepted shared status; this Foundry pin update does not qualify
arbitrary newer consumer sources or authorize Alloy crate publication. Root
owns those decisions.
The [presentation-boundary ADR](adr/0001-alloy-authenticated-presentation.md)
covers both this preview and the gateway diagnostic reference lookup on the
Status page; it does not import Alloy diagnostic reports.
