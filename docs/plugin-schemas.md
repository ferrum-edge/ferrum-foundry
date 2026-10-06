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
  (`ferrum-edge/ferrum-edge@0d917701b63ef38210c49df830f48cf0457cbc7d`,
  `info.version: 0.2.0`).
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

### v0.5.0 hosted schema adoption

The serial schema update adopts the actual Pinned Gateway Contract producer
from [run 37239682559](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37239682559),
attempt 1. Its API head is `4f729320986aa564158fc2834dfebcbb4fb7a1b3` on
`release/foundry-0.5.0`. The producer artifact name contains the tested synthetic
PR merge SHA, `74eef28b70c27251b7ebdcce5033470ee174a3a1`, rather than that API
head. Retrieval binds to the run and artifact metadata, not a guessed name.

| Actual hosted evidence | Value |
| --- | --- |
| Artifact ID | `11316747307` |
| Original artifact name | `plugin-schema-producer-74eef28b70c27251b7ebdcce5033470ee174a3a1` |
| Archive SHA-256, matching the GitHub API digest | `a626f1e24c9831c38e0a4fff4393908aab3da8ca3bc7e1c7109b4897e65985fe` |
| Exported JSON SHA-256, matching its checksum file | `c45683796aef1dbbb9dee9286f48e3b8a37a65b300c3ed3fb0edd9d41fbcd940` |
| Source repository and path | `ferrum-edge/ferrum-edge`, `openapi.yaml` |
| Source ref | `c764084b3b51c3f7ffde268c039688d35e49c553` |
| Raw source SHA-256 | `687db80271512a367814ded6002ecce546eb190a347a57e32eca36af7d665020` |
| Previous reviewed ref | `65a23411841dd363497f98c7d40f5a66ed7d1942` |

Only `RateLimitingConfig` changed: its actual exported digest is
`f6f4c095e2c9f326ba62d87094fb9e8ac3833bba9503476cf01daca1ebc6e4a1`, replacing
`3ba160df5e20745939284d67655d5dcc5cee4766e424a0a31846c0740980ed5d`.
The exported digests for `KeyAuthConfig`, `RateLimitingRuleConfig`, `CorsConfig`
and `PrometheusMetricsConfig` are unchanged. The actual component blocks were
read against the descriptors and `writeGuidedConfig`'s structural-copy behavior
before updating the ref and this one digest together.

`mcp_tool_calls` deliberately remains unmodelled in guided editing. Its object,
explicit `null` and omitted states survive a rate edit unchanged, including
nested `tools`, `per_tool`, `endpoint_path`, and unrelated raw fields. No guided
control infers this mode or inserts defaults. The raw JSON editor is the full
surface; the gateway constructor remains admission authority, including UTF-8
byte bounds, HTTP-only operation and the `per_tool`/`tools` requirement.
Regression tests cover that preservation, not runtime MCP admission.
`info.version: 0.2.0` is OpenAPI metadata, not a product version.

The original run failed on this drift before starting the contract gateway;
its producer artifact is schema evidence, not successful live qualification.
The Node gates also failed the unchanged canonical r2 mapping for v0.9.11.
Published `contracts-edge-0.9.11` was subsequently adopted in the v0.5.0 release
source, which passed hosted pairing qualification. The earlier failed run and
original artifact identities above remain schema evidence only.

The checker exports exact fetched component YAML blocks, actual hashes,
comparison findings, raw source hash, source ref and reviewed ref as JSON when
`FERRUM_SCHEMA_EXPORT_PATH` is set. The workflow now uploads both nonempty files
only after successful hashing, including when the checker reports drift. Names
are `plugin-schema-producer-<github.sha>-attempt-<github.run_attempt>`: on PRs
`github.sha` is the synthetic merge, while the API run/artifact head is the
branch head. Each attempt preserves its prior evidence; uploads never overwrite
an older attempt. Verify the API run ID, attempt, head, source identity, archive
digest and exported checksum when retrieving future evidence. The complete
OpenAPI document is never vendored, and no producer was executed locally.

Transport failures are retried; any other fetch error, including an HTTP error,
fails the check. An outage is never reported as drift, and never passes.

### v0.5.1 hosted schema adoption

The v0.5.1 schema adoption used the actual Pinned Gateway Contract producer from
[run 37336969590](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37336969590),
attempt 1, for [PR #548](https://github.com/ferrum-edge/ferrum-foundry/pull/548).
The API run and artifact head identify the PR source; the artifact name and
checkout log identify the tested synthetic merge. The retrieved archive digest
matches the GitHub API, and the exported JSON digest matches its actual producer
checksum file. The raw immutable upstream source was downloaded separately and
its byte hash matches the export's source identity.

| Actual hosted evidence | Value |
| --- | --- |
| Foundry repository ID | `1206833208` |
| Run / attempt | `37336969590` / `1` |
| PR source / API head | `0dc21a387367059785c6fbea8c7ced5a55e2af70` |
| Tested synthetic merge | `632a24eb7c5220fd06a6e9fd85d5b5b11308b898` |
| Merge base | `fa57904868affd1e2f94add5bc8daa1fdd0905f1` |
| Artifact ID | `11356821423` |
| Original artifact name | `plugin-schema-producer-632a24eb7c5220fd06a6e9fd85d5b5b11308b898-attempt-1` |
| Archive bytes / SHA-256, matching the GitHub API digest | `9430` / `0b70d1199d97635b52a71f136be3ea04599e580ba3e131956fc292b01398f911` |
| Exported JSON bytes / SHA-256, matching its checksum file | `30061` / `f7876f4e3e6fc4fe9443095c03749f9377eaeb504922c96c26e0861dc5af253f` |
| Source repository and path | `ferrum-edge/ferrum-edge`, `openapi.yaml` |
| Source ref | `0d917701b63ef38210c49df830f48cf0457cbc7d` |
| Raw source SHA-256 | `f7242228d73d34ad2d7da3c989ec6ba15bb6ae1f2f4c94a8e0a181b000caae77` |
| Previous reviewed ref, recorded by the producer | `c764084b3b51c3f7ffde268c039688d35e49c553` |

All five complete exported YAML blocks were read against the guided descriptors,
omission and explicit-null handling, structural-copy writes, unsupported-shape
fallbacks, secret-field handling, and the existing preservation tests. Every
component is `unchanged`, with its `actual` and `sha256` equal to the existing
pin:

| Component | Retained SHA-256 |
| --- | --- |
| `KeyAuthConfig` | `2489182cc16c230dd69d984441a2efcee271df44a934a8ca6d5d868f77da4deb` |
| `RateLimitingConfig` | `f6f4c095e2c9f326ba62d87094fb9e8ac3833bba9503476cf01daca1ebc6e4a1` |
| `RateLimitingRuleConfig` | `baeb7755166ff2af60d33fdc8eff36e94fb04e5b15ef099c69792a064eb2489d` |
| `CorsConfig` | `96fcc1b45b3c20b27713b0bc0c7eef23bd92810587b21115a233081da7932bf3` |
| `PrometheusMetricsConfig` | `ee96fad934766a3195cd0aa2231c55287732973f246bf4a830e4ae890b980623` |

That adoption changed only `PLUGIN_SCHEMA_SPEC.ref`. Descriptors, catalog and templates stay
unchanged. `mcp_tool_calls` remains unmodelled: its object, explicit `null` and
omitted states, nested policy, unrelated raw keys and key order survive guided
rate edits. Stored `redis_password` stays present-but-blank in guided state,
with the existing keep/replace/omit behavior. No defaults are inferred and the
gateway remains admission authority. `info.version: 0.2.0` remains schema
metadata. New deployment components are outside this guided surface.

This producer completed static schema review, not final-head pairing qualification. The
producer's Pinned Gateway Contract job succeeded, but both Node Quality Gates
failed the old readiness fixture's v0.5.0 expectation. That fixture was repaired
in `c96d342149ca3b71f6c3e96dd5bb3143b9caa464`; neither that repair nor this
provenance update is qualified by that producer run. Subsequent fresh independent
read-only review and hosted qualification passed as recorded below. The failed
v0.5.0 producer above remains historical schema evidence only.
No project tooling, producer or component extractor executed locally, and no
OpenAPI document or export is stored in the repository.

#### Qualified v0.5.1 schema evidence

The original pairing qualification
[run 37341678624](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37341678624),
attempt 1, passed all eight applicable gates and produced the following actual
schema artifact. Its metadata binds the same repository to source `157fa7f`
and tested merge `b01dd913`; it does not restamp either earlier producer.

| Actual qualified hosted evidence | Value |
| --- | --- |
| Foundry repository ID | `1206833208` |
| Run / attempt | `37341678624` / `1` |
| PR source / API head | `157fa7f478ea8e987104f6adb3cc41baf1efb2e0` |
| Tested synthetic merge | `b01dd9137635739cd453d1e3b507c24ec1aca3e3` |
| Merge base | `fa57904868affd1e2f94add5bc8daa1fdd0905f1` |
| Artifact ID | `11358382729` |
| Original artifact name | `plugin-schema-producer-b01dd9137635739cd453d1e3b507c24ec1aca3e3-attempt-1` |
| Archive bytes / SHA-256, matching the GitHub API digest | `9395` / `fbde655c7122acb4412d63cd4c79fecc977121511bd703f091330616d4e258f8` |
| Exported JSON bytes / SHA-256, matching its checksum file | `30061` / `6d8eb6f1f34ebff466e4a1c318b9b6be259ee25960f7da0ea70ae426af72d48c` |
| Source repository and path | `ferrum-edge/ferrum-edge`, `openapi.yaml` |
| Source ref and reviewed ref | `0d917701b63ef38210c49df830f48cf0457cbc7d` |
| Raw source SHA-256 | `f7242228d73d34ad2d7da3c989ec6ba15bb6ae1f2f4c94a8e0a181b000caae77` |

All five complete exported components are `unchanged`, with `actual` and
`sha256` equal to the retained hashes above. The schema ref, component hashes,
descriptors, catalog, templates and preservation behavior are unchanged in this
post-publication record. Actual v0.5.1 release run `37351255936`, attempt 1,
repeated all eight pairing gates at published source
`1dc43bd1bbd4c2c89ca14e2a603aa478ab1a0d18`. Its Pinned Gateway Contract
schema check passed. Publication and repeated tag-run evidence are separate
from the original qualification object in the
[immutable v0.5.1 record](release-notes/v0.5.1.compatibility.json).

### v0.5.2 schema review

The v0.5.2 candidate moves `edge.source_commit` to published Edge v0.9.13,
`9b83115de7ec23ab51ec4feae6bed65e596db425`. Its raw `openapi.yaml` (SHA-256
`5f3e50e217b22b97d068490bdad9563ea450097a2daf7df4f80ff61f98559a81`) was
downloaded from the immutable source alongside the reviewed 0d917701 document.
Each of the five components was extracted with the block rule above and
compared byte for byte:

| Component | Result at 9b83115d | SHA-256 |
| --- | --- | --- |
| `KeyAuthConfig` | byte-identical to 0d917701 | `2489182cc16c230dd69d984441a2efcee271df44a934a8ca6d5d868f77da4deb` |
| `RateLimitingConfig` | byte-identical to 0d917701 | `f6f4c095e2c9f326ba62d87094fb9e8ac3833bba9503476cf01daca1ebc6e4a1` |
| `RateLimitingRuleConfig` | byte-identical to 0d917701 | `baeb7755166ff2af60d33fdc8eff36e94fb04e5b15ef099c69792a064eb2489d` |
| `CorsConfig` | byte-identical to 0d917701 | `96fcc1b45b3c20b27713b0bc0c7eef23bd92810587b21115a233081da7932bf3` |
| `PrometheusMetricsConfig` | byte-identical to 0d917701 | `ee96fad934766a3195cd0aa2231c55287732973f246bf4a830e4ae890b980623` |

The v0.9.13 OpenAPI changes are confined to backend egress policy
`schema_version: 2`, the deployment snapshot's `StoredContentDigest` and
`api_spec_contents`, and the `NamespaceSnapshotTooLarge` `507` responses;
none touches a guided plugin. Descriptors, catalog, templates, secret handling
and `mcp_tool_calls` preservation are unchanged. `PLUGIN_SCHEMA_SPEC.ref` keeps
naming 0d917701, the last ref adopted from a reviewed hosted producer export;
the Pinned Gateway Contract drift check still compares every pinned hash at the
new `edge.source_commit`. Moving the ref to 9b83115d waits for review of this
candidate's own producer artifact. No project tooling or producer ran locally,
and no OpenAPI document or export is stored in the repository.

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
