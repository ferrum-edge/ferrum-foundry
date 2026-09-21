# Guided plugin configuration

Four plugins — `key_auth`, `rate_limiting`, `cors`, and `prometheus_metrics` —
can be configured through labelled controls instead of a JSON textarea. This
document records where those controls come from, what they will and will not
do to a configuration, and how the derivation is kept honest.

The advanced raw-JSON editor is unchanged and remains the complete surface.
Guided editing is assistance; the gateway is still the only authority on
whether a configuration is valid.

## Where the fields come from

Every label, description, enum, bound, and pattern in `src/lib/pluginSchemas.ts`
is a transcription of a named schema component in the canonical Ferrum Edge
`openapi.yaml` — not invented UI copy:

| Plugin | Components |
| --- | --- |
| `key_auth` | `KeyAuthConfig` |
| `rate_limiting` | `RateLimitingConfig`, `RateLimitingRuleConfig` |
| `cors` | `CorsConfig` |
| `prometheus_metrics` | `PrometheusMetricsConfig` |

## Provenance and the drift check

Foundry deliberately keeps **no copy** of `openapi.yaml` (see CLAUDE.md), so
what is stored instead is the reviewed reduction plus the SHA-256 of each
source block. That digest is the record of what the field set was checked
against.

`PLUGIN_SCHEMA_SPEC` pins the upstream revision
(`ferrum-edge/ferrum-edge@65a2341`, `info.version: 0.2.0`) and
`PLUGIN_SCHEMA_PROVENANCE` pins the digests.
`scripts/plugin-schema-drift.mjs` re-fetches the spec on every pull request —
it runs in the `Pinned Gateway Contract` job, and as `npm run
check:plugin-schemas` locally — extracts each block and compares. A changed or
removed block fails the job, naming the component.

**Do not update a digest without re-reading the schema.** A structured editor
derived from an older schema is exactly how fields a newer gateway understands
start getting stripped; the digest exists so that cannot happen quietly. The
extraction rule (a block runs from its four-space key line to the next key at
that indentation, trailing blank lines dropped) is fixed by
`scripts/plugin-schema-drift.test.mjs`, which also asserts that every guided
plugin's components are pinned.

The drift check retries transport failures and fails on anything else: a
GitHub outage must not be reported as drift, and must not pass either.

## What guided editing does to a configuration

### It is lossless

`writeGuidedConfig` starts from a structural copy of the configuration and
touches only the keys the descriptors name. Therefore:

- **Unmodelled keys round-trip.** A newer gateway field, or one this reduction
  deliberately leaves out, is carried through untouched.
- **Key order is preserved**, so JSON → guided → JSON of an untouched
  configuration is byte-identical.
- **Nested siblings survive.** Editing the rate limit inside `limits[0]` does
  not disturb other keys in that rule.

### Omission is a value

A full-replacement `PUT` treats an absent key, an explicit `null`, and an empty
string as three different instructions. The guided view keeps them apart: an
unset field renders as *Not set*, states what the gateway does in its absence,
and has an explicit control to set or omit it. It never materialises a default
into the configuration just because a control needed something to show.

### A shape it cannot model is refused, not reshaped

Some configurations are outside what these descriptors represent. Each one is
reported with its reason and the editor stays on raw JSON:

| Situation | Why |
| --- | --- |
| A `rate_limiting` policy with more than one rule, or whose single rule is not `scope: default` | Per-consumer rules carry their own counters and cross-rule identity constraints the field set does not express |
| `cors.allowed_origins` containing Istio `StringMatch` objects | Object `exact`/`prefix`/`regex` have deliberately different matching semantics from the native string form, and must not be broadened by rewriting |
| A `cors` policy with `unmatched_preflights` | That marker changes what omitted method, header, and max-age fields mean; editing it structurally would rewrite those omissions |

This is a supported outcome, not a failure. Nothing is changed, and the whole
configuration remains editable.

### Secrets are never displayed

`redis_password` is marked secret. It is read as present-but-blank, so it never
reaches the DOM, browser storage, or a validation message. Leaving it blank
keeps the stored value; typing a new one replaces it; omitting the field
removes it. Editing an unrelated rate-limit field never requires re-entering
it.

## Validation, and what it is not

Client-side validation reports what the schema states: required fields, enum
membership, numeric bounds, patterns, list bounds, and the cross-field rules
the schema expresses (a rate-limit rule uses preset rates **or** the custom
window pair, never both; `sync_mode: redis` needs `redis_url`; credentials
cannot be combined with a wildcard origin). Errors are inline, carry
`aria-invalid` and `aria-describedby`, and are announced with `role="alert"`.

It is **not** a substitute for gateway admission. A configuration that passes
here can still be refused, and the gateway's own error is displayed unchanged.

Prerequisites that only the deployment can satisfy — consumers holding a
keyauth credential, Redis reachable through the gateway's egress policy, TLS
trust material present — are shown as explicitly unconfirmed notes. Foundry
does not know whether they hold, and never presents them as satisfied.

## Interaction with the defaults contract

Guided editing starts from the same templates as before, so the real-gateway
admission checks in `scripts/plugin-defaults-contract.mjs` still cover every
guided plugin's starting configuration. `pluginGuidedConfig.test.ts` asserts
that each of those templates is representable and round-trips unchanged, so a
template change that the guided view could not express would fail here rather
than silently degrade the editor.

## Coverage

| Concern | Test |
| --- | --- |
| Losslessness, omission/clear semantics, secrets, unsupported shapes, validation | `src/lib/pluginGuidedConfig.test.ts` |
| Labelled controls, inline accessible errors, submit refusal, JSON round trip, fallback reason | `src/components/forms/PluginConfigForm.guided.test.tsx` |
| Block extraction, digest stability, pinned-component coverage | `scripts/plugin-schema-drift.test.mjs` |
| The digests still match upstream | `scripts/plugin-schema-drift.mjs` (CI) |

## Not in scope

A visual designer for every plugin, a universal form builder, and any Foundry
database. Adding a plugin means adding its descriptors and its pinned digest —
the rest of the machinery is shared.
