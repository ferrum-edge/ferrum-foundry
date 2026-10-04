# Guided plugin configuration

Four plugins — `key_auth`, `rate_limiting`, `cors`, and `prometheus_metrics` —
can be edited with labelled controls instead of raw JSON. The raw JSON editor
is still available and remains the complete surface. Guided editing is
assistance: the gateway alone decides whether a configuration is valid.

## Where the fields come from

Every label, description, enum, bound, and pattern in `src/lib/pluginSchemas.ts`
is transcribed from a named schema component in the Ferrum Edge `openapi.yaml`:

| Plugin | Components |
| --- | --- |
| `key_auth` | `KeyAuthConfig` |
| `rate_limiting` | `RateLimitingConfig`, `RateLimitingRuleConfig` |
| `cors` | `CorsConfig` |
| `prometheus_metrics` | `PrometheusMetricsConfig` |

## Provenance and the drift check

Foundry keeps no copy of `openapi.yaml`. It stores the reviewed descriptors and
the SHA-256 of each source component block instead:

- `PLUGIN_SCHEMA_SPEC` pins the upstream commit
  (`ferrum-edge/ferrum-edge@65a2341`, `info.version: 0.2.0`).
- `PLUGIN_SCHEMA_PROVENANCE` pins one digest per component.

`scripts/plugin-schema-drift.mjs` (`npm run check:plugin-schemas`) fetches
`openapi.yaml`, extracts each block, and compares digests. A changed or missing
block fails, naming the component. By default the **Pinned Gateway Contract**
CI job checks the current `edge.source_commit` from `docs/compatibility.json`.
To check against a newer spec, set the ref:

```bash
FERRUM_SPEC_REF=main npm run check:plugin-schemas
```

**Do not update a digest without re-reading the schema.** A structured editor
built from an older schema is how fields a newer gateway understands get
stripped. When you re-review, update `PLUGIN_SCHEMA_SPEC.ref` and the digests
together.

A block runs from its four-space key line to the next key at that indentation,
with trailing blank lines dropped. `scripts/plugin-schema-drift.test.mjs` fixes
that rule and checks that every guided plugin's components are pinned.

### v0.5.0 draft qualification

The reviewed ref and digests above are retained while the Edge v0.9.11 pin is
prepared. At released Edge commit `c764084b3b51c3f7ffde268c039688d35e49c553`,
`RateLimitingConfig` includes `mcp_tool_calls`; these older pins do not establish
qualification against that source. `info.version: 0.2.0` is OpenAPI schema
metadata, not the Edge or Foundry product version.

The existing drift checker now exports the exact fetched component YAML blocks,
actual hashes, comparison findings, raw source hash, source ref and reviewed ref
as JSON when `FERRUM_SCHEMA_EXPORT_PATH` is set. The Pinned Gateway Contract job
writes `plugin-schema-producer.json`, hashes that exact file, and uploads both
files as `plugin-schema-producer-<Foundry head SHA>`, even when drift fails.
This is the checker's hosted producer output; no local generated schema or
source-derived guess substitutes for it. The complete OpenAPI document is not
vendored.

Root must retrieve the artifact from the actual hosted run for this branch,
verify its checksum and c764 source identity, review the affected descriptors
and omission/null semantics, then update `PLUGIN_SCHEMA_SPEC.ref` and the
component hashes in one serial finisher. Re-run all hosted qualification gates
at the resulting head. Drift continues to fail until that review and update;
no producer artifact hash or new component digest is invented in this draft.

Transport failures are retried; any other fetch error, including an HTTP error,
fails the check. An outage is never reported as drift, and never passes.

## What guided editing does to a configuration

### It is lossless

`writeGuidedConfig` starts from a structural copy of the configuration and
touches only the keys the descriptors name:

- **Unmodelled keys round-trip**, including fields from a newer gateway.
- **Key order is preserved**, so JSON → guided → JSON of an untouched
  configuration is byte-identical.
- **Nested siblings survive.** Editing the rate limit in `limits[0]` leaves the
  rule's other keys alone.

### Omission is a value

A full-replacement `PUT` treats an absent key, `null`, and an empty string
differently, and the guided view keeps them apart. An unset field shows
*Not set* with what the gateway does in its absence, and has an explicit control
to set or omit it. A default is never written just because a control needed
something to display.

### Unsupported shapes fall back to JSON

When a configuration is outside what the descriptors model, the editor stays on
raw JSON and states why. Nothing is changed.

| Situation | Why |
| --- | --- |
| `rate_limiting` without a `limits` array, with more than one rule, or whose single rule is not `scope: default` | Per-consumer rules carry their own counters and cross-rule constraints the field set does not express |
| `cors` without an `allowed_origins` array, or with Istio `StringMatch` objects in it | `exact`/`prefix`/`regex` objects match differently from the native string form and must not be rewritten |
| `cors` with `unmatched_preflights` | That marker changes what omitted method, header, and max-age fields mean |
| An enum value in a spelling the gateway accepts but the control does not offer (`limit_by: "Consumer"`, the `spiffe` alias, `sync_mode: "Redis"`) | The schema parses these case-insensitively; canonicalising them would rewrite the operator's configuration |

### Secrets are never displayed

`redis_password` is marked secret and read as present-but-blank, so it never
reaches the page, browser storage, or a validation message. Leave it blank to
keep the stored value, type a new one to replace it, or omit the field to remove
it. Editing other fields never requires re-entering it.

## Validation

Client-side checks cover what the schema states: required fields, enum
membership, numeric bounds, patterns, list bounds, and cross-field rules (a
rate-limit rule uses preset rates **or** the custom window pair, never both;
`sync_mode: redis` needs `redis_url`; CORS credentials cannot be combined with
a wildcard origin). Errors are inline, set `aria-invalid` and
`aria-describedby`, and are announced with `role="alert"`.

Client validation may be looser than the gateway but never stricter. Where a
pattern cannot express the schema exactly (for example the Redis URL's `2^31-1`
database bound), the guided pattern is the looser one. A configuration that
passes here can still be refused; the gateway's error is shown unchanged.

Prerequisites only the deployment can satisfy — consumers holding a key-auth
credential, Redis reachable through the gateway's egress policy, TLS trust
material — are shown as unconfirmed notes, never as satisfied.

## Templates and tests

Guided editing starts from the [plugin templates](plugin-defaults.md), which the
gateway contract admits against the pinned gateway. `pluginGuidedConfig.test.ts`
checks that each guided plugin's template is representable and round-trips
unchanged.

| Concern | Test |
| --- | --- |
| Losslessness, omission/clear semantics, secrets, unsupported shapes, validation | `src/lib/pluginGuidedConfig.test.ts` |
| Labelled controls, inline accessible errors, submit refusal, JSON round trip, fallback reason | `src/components/forms/PluginConfigForm.guided.test.tsx` |
| Block extraction, digest stability, pinned-component coverage | `scripts/plugin-schema-drift.test.mjs` |
| Digests match the pinned spec | `scripts/plugin-schema-drift.mjs` (CI) |

Adding a guided plugin means adding its descriptors and pinned digests; the rest
is shared. There is no per-plugin form builder and no Foundry database.
