# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer.
[`compatibility.json`](compatibility.json) is the machine-readable current
pairing record, and CI reads the gateway image from it.

**Record version 2, status: candidate; qualification: pending.** The unreleased
Foundry v0.5.7 candidate pins published Edge v0.9.21, the latest Edge release
(#728), and vendors canonical `contracts-edge-0.9.21` (#723). The latest
published pairing remains Foundry v0.5.6 / Edge v0.9.20, whose source, image,
qualification and publication evidence are preserved byte-for-byte in the
immutable [v0.5.6 record](release-notes/v0.5.6.compatibility.json). Earlier
pairings and their immutable records are in [History](#history).

## The candidate pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | v0.5.7 (candidate); previous release v0.5.6 | [Ferrum Edge v0.9.21](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.21) |
| Source commit | *release step* | `f9915358c8032214f4034a17c28cdf72d14006c3`, immutable `v0.9.21` tag target |
| Image | *release step* | `ferrumedge/ferrum-edge@sha256:e6b0e4801609ea928b561494c6c5ed518ba97908d6e2dfcb6dd59998eb4f93be` |
| Platforms | `linux/amd64`, `linux/arm64` (*release step*) | `linux/amd64` `sha256:dff4c3afbb8a4c43939f6dc0628b74f0852de2c5c5fb69dfcb4e0073126e2abf`; `linux/arm64` `sha256:f7811d35889f7357c59a04b606451c689857a134937638ddd55e92538a123658` |
| Qualification | Pending | [Edge release run 44972356983](https://github.com/ferrum-edge/ferrum-edge/actions/runs/44972356983) (attempt 2); distribution evidence only |
| Publication | *release step* | GitHub release 454250773, published 2026-11-22 06:29:03 UTC |

Edge v0.9.21 ships non-admin TLS-material and trigger-operand redaction, exact
`[REDACTED]` placeholder reservation on plugin writes, consumer credential
`If-Match` preconditions, external-identity trigger predicates, and further
config-admission cleanups. The changes Foundry reacts to are in
[Admin API changes in v0.9.21](#admin-api-changes-in-v0921).

## The CI pin

Every gateway-backed gate reads `edge.image`, the published v0.9.21 default
multi-architecture index above. Edge release `454250773` was published at
2026-11-22 06:29:03 UTC from tag commit
`f9915358c8032214f4034a17c28cdf72d14006c3`. Release run `44972356983` (attempt
2) completed 19 of 20 jobs successfully, including all platform builds, default
and eBPF manifests, signing, attestation, GitHub release creation, and both
release gates (Linux GNU ABI and image attestation); its `Anonymous image pull
smoke` job failed on `SQLite volume smoke` (expecting UID/GID `65532:65532`,
observing `65532`). Both Docker Hub tags `0.9.21` and `v0.9.21` (and GHCR
`v0.9.21`) resolve to the recorded index digest and two platform manifests.
`edge.release.binary_sha256` records the seven published binary hashes; each
equals its GitHub API asset digest and the release notes checksum table.

Unlike the v0.9.15 pin, the image layers were not downloaded for this move, so
`distribution.default_image_binaries_match_release_assets` is `null`: no byte
comparison of the image's `ferrum-edge` and `ferrum-cni` binaries with the
release assets is claimed. Edge's release workflow builds the default image
from the same build artifacts it publishes as assets (`Dockerfile.release`
copies them), and the hosted gates run the image itself. No binary or image
ran locally for this preparation.

Anonymous GHCR access is not claimed. Published Edge configs have no revision
label. Source identity rests on the immutable release tag and the release
run's attestation gate; no local cryptographic verification is claimed. The
`0.9.21-ebpf` and `0.9.21-ebpf-tools` variants are published but outside the
v0.5.7 qualification target.

The raw canonical OpenAPI at the immutable Edge source has SHA-256
`13c21d12d3028c8044ad2f467cbca6425d9bd2f3fce787d6fe7ae78316c21bee`.
Its `info.version: 0.2.0` is schema metadata, not either product's version.

## Qualification evidence

1. **Canonical contracts re-vendored (`contracts-edge-0.9.21`, #723).**
   Signed tag
   [contracts-edge-0.9.21](https://github.com/ferrum-edge/ferrum-contracts/tree/92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f)
   (`92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f`, 37 scoped files) is vendored
   byte-exact in `contracts/ferrum-contracts/PIN`. Edge v0.9.21 retains all
   82 plugins, priorities (`PLUGIN_PRIORITY`), stream protocols
   (`src/lib/pluginProtocols.ts`), and `provisioned-by` attribution while
   binding vocabulary provenance to Edge v0.9.21 (`f9915358`) and shipping
   the `ferrum-contracts#74`/`#82` `service-manifest` v1 schema rules and all
   31 shared manifest fixtures (5 valid, 26 invalid).
   `scripts/ferrum-contracts.test.mjs` maps `contracts-edge-0.9.21` to
   `["v0.9.21"]` and binds the vocabularies directly to `docs/compatibility.json`.
2. **Guided schema static review complete.** At
   `f9915358c8032214f4034a17c28cdf72d14006c3`, `KeyAuthConfig`, `CorsConfig`,
   and `PrometheusMetricsConfig` are byte-identical to `e4a606a0`.
   `RateLimitingConfig` removes the redundant `default:` keyword on
   `redis_key_prefix` while keeping the same prose default;
   `RateLimitingRuleConfig` updates the unmodelled `consumers` description to
   state mapped Consumer username matching only (GHSA-rxwj-x6c6-f4j5). Neither
   changes any guided descriptor. `PLUGIN_SCHEMA_SPEC.ref` and the two digests
   move to `f9915358`. `SubsetTrafficPolicy` is byte-identical to `e4a606a0`,
   and `SUBSET_TRAFFIC_POLICY_SOURCE` moves to `f9915358`.
   [Plugin schemas](plugin-schemas.md#review-history) records the review.
3. **Sensitivity source re-read (#728).** `plugin_config_projection.rs` changed
   (Git blob `d50b0d53b7a4ace7454a25a7e8034b4a8ea5c1a8` to
   `5f96f581ead10e8c777fc088fda10ffe89c96b6d`). Sixteen plugins gain rules:
   `request_termination`, `transaction_debugger`, `ai_semantic_firewall`,
   `waf`, `openapi_validator`, `ai_tool_governor`, `mcp_gateway`, `opa`,
   `mesh_route_dispatch`, `request_mirror`, `mtls_auth`, `soap_ws_security`,
   `udp_logging`, `mesh_authz`, plus `redis_url` on `jwks_auth`, `hmac_auth`,
   and `soap_ws_security`. Foundry's table follows rule for rule and
   `PLUGIN_SENSITIVITY_SOURCE` names `f9915358`. Trigger predicate lists
   (`TRIGGER_CLIENT_FIELD_PREDICATES`, `TRIGGER_VISIBLE_PREDICATES`, including
   `external_identity` and `external_identity_authority`) and
   `PluginTriggerMatch` match v0.9.21.
4. **Hosted pairing qualification pending.** Every gate must run and pass on
   the candidate source before v0.5.7 is tagged: Qualification Source, Quality
   Gate on Node 22 and 24, Pinned Gateway Contract (including writable and
   read-only capability parity), Deployment Starter, Starter Production
   Profile, Critical Journeys, and both Container Gates. Prior v0.5.6 evidence
   cannot qualify this pin.
5. **Foundry publication pending.** *release step* after qualification passes.

The database profiles, Node floors and `viewer` / `operator` / `admin` tiers are
unchanged. Like v0.5.2 through v0.5.6, this candidate includes the initial
untagged-write refusal of the adopted guarded-write policy #542 (see
[below](#guarded-write-initial-validator-policy-542)).

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; every published release since, v0.9.8
   through v0.9.21, retains it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5 and v0.9.7 through v0.9.21, has both:
   - Edge attaches the proxy association itself when a proxy-scoped plugin
     configuration is written (ferrum-edge#4611).
     `scripts/starter-journey.mjs` checks that the configuration protects the
     route as soon as it is created, and that attaching it again by hand
     changes nothing.
   - Edge keys proxies, upstreams, plugin configurations, and API specs on
     `(namespace, id)` (ferrum-edge `5db1d77a8`).
     `e2e/journeys/namespace-isolation.spec.ts` checks that two namespaces
     holding the same id stay isolated for reads, writes, deletes, and the UI.

   A release that changes either must pass the gates without weakening what
   they check.
3. **The full qualification is re-run against it.** The pull request that sets
   `edge.release` and moves `edge.image` to that release must pass every job
   before any Foundry release is published: Quality Gate, Pinned Gateway
   Contract (including capability parity, writable and read-only), Deployment
   Starter, Starter Production Profile, Critical Journeys (Chromium, Firefox
   and WebKit), Gateway Modes (file, CP + DP, mesh, PostgreSQL, MySQL and
   MongoDB), and Container Gate.
   `QUALIFICATION_JOBS` in `scripts/hosted-qualification.mjs` is that list;
   release readiness refuses a run in which any of them did not succeed. The
   release evidence recorded in `qualification` is a successful hosted run of
   `ci.yml` itself: a `main` push run of the candidate source. Pull-request
   runs come from the required-workflow ruleset under another workflow id,
   which release readiness refuses, so they are required checks only.

`node scripts/supported-pairing.mjs release-ready` verifies this through hosted
GitHub Actions with `actions: read` and `contents: read`. The release workflow
refuses a tag while `edge.release` still holds `RELEASE-STEP` placeholders or
`edge.image` is not that release.
It also refuses a record that is no longer the unreleased `candidate`: tag the
commit that prepares the release, whose `foundry.source_commit`, `image`, and
`ci_evidence` are still null and `qualification` names the successful hosted
run. The release step fills them and sets `status: "released"` on `main`
afterwards, so no later commit can publish the same version again (see
`docs/release-security.md`, "Release version tags are never reassigned").

Plugin-config `PUT`/`DELETE` also send Edge's `expected_proxy_ids` association
precondition
([ferrum-edge-git-forge-ops#569](https://github.com/ferrum-edge/ferrum-edge-git-forge-ops/issues/569),
[ferrum-edge#6744](https://github.com/ferrum-edge/ferrum-edge/pull/6744)),
which Edge requires from v0.9.18 (tagged but unpublished; first published in
v0.9.19). It is a requirement of this pairing (`edge_dependencies` records
ferrum-edge#6744): v0.9.20 refuses a plugin-config update or delete without it
with `400`, and refuses one with `412`, atomically with the write, when it
would detach a proxy outside the expected set, closing the race between
Foundry's membership listing and the write; see
[plugin membership](plugin-membership.md#scope-changes-and-proxy-scoped-plugins).
The published v0.5.5 / v0.9.15 pairing predates the parameter, and v0.9.15
ignores it.

The sections below record what each Edge release changed on surfaces Foundry
uses. The full per-release review narratives, with blob hashes, advisory and
data-plane change lists, are in the
[v0.5.5 tagged copy of this page](https://github.com/ferrum-edge/ferrum-foundry/blob/v0.5.5/docs/compatibility.md).

### Admin API changes in v0.9.8

None that Foundry reflects. Its admin routes, role checks, `ETag`/`If-Match`
handling, `proxy_id` filter, plugin sensitivity table, and scope merge are
those of v0.9.7. The one `openapi.yaml` change on a surface Foundry edits is a
new optional `adaptive_concurrency` field, `baseline_window_samples` (default
`1000`), which Foundry's default template omits and its raw editor passes
through unchanged.

### Admin API changes in v0.9.9

The release adds `GET /proxies/{id}/mcp/tools`, a viewer-readable,
namespace-scoped read of an MCP proxy's cached tool catalog. Proxy resources also
gain `allow_path_parameters` for RFC 3986 semicolon path parameters; Foundry
models and edits this flag. The capability
parity contract probes it as each role. Viewer-key namespace ceilings now
apply to namespace-scoped routes, filter the namespace registry, and deny
unlisted global routes; the deployment CI continues to exercise ordinary
trusted-proxy role and namespace claims.

`operator` reads mask plugin configuration secrets (`[REDACTED]`), the
components of an endpoint URL that may carry credentials (`redacted@` userinfo,
`/[REDACTED_PATH]`, `?[REDACTED_QUERY]`, `#[REDACTED_FRAGMENT]`), and an
upstream's Consul ACL token (`[REDACTED]`). Edge v0.9.9 refuses with `400`,
before update merging, a `POST` or `PUT` of an upstream or plugin configuration
that echoes one of those placeholders at a field the caller's read masks
(ferrum-edge#5925), and names each field by JSON pointer. For upstreams and
plugin configurations a placeholder is therefore not a round-trip marker.
Consumers are different: they are `admin`-only, and a `[REDACTED]` credential
entry is still restored from the stored one.

Foundry mirrors Edge's placeholder check (`src/api/maskedSecrets.ts`) and the
sites where Edge applies it (`src/api/maskedSecretSites.ts`): nowhere for an
`admin`, whose reads are raw; for other roles, only where the read projection
masks the field, replayed from the CI-checked copy of Edge's schema rules
(`pluginSensitivity.ts`), its name floor, and its URL-userinfo sweep. A plugin
Foundry has no rules for has every placeholder treated as masked. Edge `main`
(ferrum-edge#7054, after v0.9.20) adds a TLS-material layer that refuses the
exact `[REDACTED]` in any string of a non-admin plugin-config write, as #7060
does for proxies and upstreams, and three field classes: certificate sources
(visible unless they carry a private-key block), private-key sources (visible
only as a reference), and destination paths (visible only as `""` or `/`).
The replay models both already, so against v0.9.20 it also blocks a literal
`[REDACTED]` in an ordinary field, which fails closed. The plugin
and upstream editors mark each masked field that still holds a placeholder,
block Save until it is re-entered or cleared (clearing omits it, which deletes
the stored secret, because `PUT` is a full replace), only point out a
URL-shaped placeholder anywhere else, and show Edge's `400` field list when a
save is refused anyway. In a plugin configuration the exact `[REDACTED]` in an
unmasked field, and a placeholder at a certificate or private-key source,
block Save without a Clear action: each must be entered again. A non-admin targets save on an upstream whose Consul
token is masked, and a plugin rollback whose earlier read was masked for the
session's role, are refused locally and reported instead of being sent. The Pinned Gateway
Contract checks that an `operator` read-modify-write of a plugin configuration
with a masked endpoint path is refused, that the fields Edge refuses for an
`operator` are exactly the ones Foundry's replay predicts (a placeholder in
`otel_tracing`'s `authorization` is refused; one in its `service_name` is
refused by Edge `main` and, as the one expected difference, accepted by the
pinned v0.9.20), and that an `admin` may write a placeholder. `npm run check:plugin-sensitivity`
also fails if Edge's table ever gains rules whose order would change the sites
the replay finds.

The proxy page's MCP Tools tab built on these reads is described in
[MCP Tools tab](mcp-tools.md).

### Admin API changes in v0.9.7 that Foundry reflects

From Edge's [upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.7/docs/upgrade_guide.md)
("Upgrading to 0.9.7"):

- **`If-Match` is strict.** A malformed or empty `If-Match`, or one on a route
  that does not evaluate it (any `POST`, `/batch`,
  `/gateway-trust-bundles/{id}`), is `400`. Foundry sends `If-Match` only on
  `PUT`/`DELETE` of the four resource item paths and on the indexed credential
  delete, and only with a strong tag read from the gateway
  (`src/api/conditionalWrite.ts`). For the credential delete the tag is
  deliberately the one from the read the operator selected the index from,
  not a fresh read; Edge's `412` covers staleness (ferrum-edge#7393). An Edge
  without that precondition (v0.9.20 included) refuses the header there with
  its `If-Match is only supported on …` `400` before acting; Foundry detects
  that answer and falls back to a verified re-read (see
  [concurrent-edits.md](concurrent-edits.md#indexed-credential-deletes)).
  The mock admin gateway refuses the same way on the other routes, and the
  gateway contract asserts both `400`s and pins which answer the pinned Edge
  gives to a conditional credential delete.
- **`GET /plugins/config?proxy_id=`** (ferrum-edge#5726) lists the
  proxy-scoped configurations targeting one proxy, paginated over the filtered
  set. Foundry uses it for a proxy's Plugins tab
  ([data-loading.md](data-loading.md)).
- **Stricter validation.** An upstream's active health check `http_path` must
  start with `/`, and `udp_probe_payload` must be even-length hex. The upstream
  form checks both before submitting, and the mock gateway refuses them with
  `400`. Other new refusals concern gateway settings or plugin configuration
  that Foundry passes through unchanged; the gateway's `400` is shown as
  returned.
- **Diagnostic wording.** Plugin configuration errors now quote field names
  and values with backticks and double quotes instead of single quotes. The
  gateway contract compares each default-template rejection as an exact string
  recorded from the pinned gateway ([plugin-defaults.md](plugin-defaults.md)).

### MCP security fixes in v0.9.10

Ferrum Edge v0.9.10 contains ferrum-edge#5954: the `mcp_gateway` and
`ai_prompt_shield` plugins refuse requests that declare a non-UTF-8 charset and
fail closed on JSON-RPC batches they cannot inspect. Foundry's gateway API
contracts and `PLUGIN_SENSITIVITY` are unchanged.

### Admin API and plugin schema changes in v0.9.11

The released source adds admin-only credential-complete
`GET /consumers/{id}/verification`, coherent conditional namespace backups,
namespace `If-Match` on restore, and process-scoped backend egress metadata.
Foundry refuses browser proxy access to verification before signing or fetching
and keeps ordinary unredacted backup exports in a temporary download operation.
It does not adopt conditional restores or backend egress policy decisions.
`RateLimitingConfig`'s optional `mcp_tool_calls` object (already in v0.9.10)
stays unmodelled in guided editing
([plugin schemas](plugin-schemas.md#current-schema-notes)).

### Admin API changes in v0.9.12

Published Edge v0.9.12 adds admin-only `GET /deployment-snapshot`, with
complete original secret-bearing evidence and a distinct strong quoted
`deployment-v1` token, used by opt-in conditional proxy delete and API-spec
replacement ([owner contract](https://github.com/ferrum-edge/ferrum-edge/blob/0d917701b63ef38210c49df830f48cf0457cbc7d/docs/deployment_mutations.md)).

Foundry refuses the secret-complete deployment snapshot at the browser-facing
BFF boundary. Every method and role receives
`403 FERRUM_BFF_CREDENTIAL_READ_DENIED` after authentication and before
capacity admission, JWT signing or upstream fetch. The denial uses the
normalized root pathname, including encoded components, an optional trailing
slash and queries; ambiguous paths retain the existing `400` refusal. Consumer
verification remains blocked, while ordinary masked reads and ephemeral backup
downloads retain their existing behavior. Foundry adds no native deployment
workflow, recovery journal, conditional restore or capability and changes no
ordinary mutation semantics.

### Admin API changes in v0.9.13

Published Edge v0.9.13 bounds namespace and deployment snapshot authority
(ferrum-edge#5999/#6012); every conditional backup tag and `deployment-v1`
token issued by v0.9.12 or earlier fails closed with `412`.
`GET /deployment-snapshot` adds the required `api_spec_contents` array with one
base64 copy of every stored spec document and external-reference snapshot, so
the response remains secret-complete. Foundry's path-based browser refusal is
unchanged: every method and role still receives
`403 FERRUM_BFF_CREDENTIAL_READ_DENIED` before capacity admission, JWT signing
or upstream fetch.

Oversized snapshots are refused with `507 Insufficient Storage` on the
conditional paths (`GET /backup?conditional=true`, a tagged `POST /restore`,
the conditional proxy delete and API-spec replacement, and the snapshot read).
Foundry issues none of these conditional requests. A raw request that reaches
one through the BFF gets the gateway's `507` status and body unchanged, and its
long-read or upload permit is released; `server/proxy-confinement.test.ts`
covers all four routes beyond both pool sizes.

### Admin API changes in v0.9.14

Published Edge v0.9.14 adds control-plane attestation of data-plane backend
egress policy (ferrum-edge#6020); CP and DP must run the same build. Foundry
does not read `GET /backend-egress-policy`, and its namespace route ceiling
refuses it to a scoped session ([Admin API coverage](admin-api-coverage.md)).

`GET /cluster` on a control plane adds each data plane's
`backend_egress_policy_attestation` (`reported` or `unknown`) and
`backend_egress_policy` (presence-only metadata, `null` when unknown), plus a
cluster-wide `data_plane_backend_egress_policy` aggregate with reporting and
unknown counts, a field-wise weakest policy and
`all_connected_public_only_guaranteed`. `data_planes` now lists one entry per
live Subscribe stream, so several entries can share a `node_id`, and
`connected_data_planes` counts streams. Foundry's Cluster page keys each stream
separately so none is collapsed, labels each data plane's reported mode or
`unknown`, and summarizes the aggregate. The page states that the reports are
self-descriptions from connected data planes, not host attestation, and that a
disconnected data plane serving cached configuration is not listed. A response
without these fields renders as before. `ClusterStatus` in `src/api/ops.ts`
types the new fields as optional.

Foundry issues no deployment mutation and still refuses
`GET /deployment-snapshot` at the BFF for every method and role. Edge's refusal
of a published OIDC session-secret fixture key is shown as returned; the
gateway contract submits a freshly generated 32-byte secret.

### Admin API changes in v0.9.15

Published Edge v0.9.15 is a security release: it fixes 26 published Ferrum
Edge advisories (5 high, 19 medium, 2 low). Most of its changes are data-plane,
mesh, Gateway API, Helm chart and ConfigSync behavior. ConfigSync stays at
protocol revision `3`, so CP and DP still run the same build, and there is no
core schema change. The changes Foundry's BFF and UI react to are:

- **Plugin-config environment references** (ferrum-edge#6086, PR #6089). A
  plugin config field that names a process environment variable resolves only
  `FERRUM_PLUGIN_SECRET_<NAME>` (`<NAME>` uppercase `[A-Z_][A-Z0-9_]*`); any
  other name, including every other `FERRUM_*` setting, is refused with `400`
  before anything is read. The affected fields are `api_chargeback_sink`
  `clickhouse.password_ref`, `ai_semantic_firewall` `provider.api_key_env`,
  `ai_stream_router` `api_key: "${...}"`, `workload_metrics` Lightstep
  `access_token_env` / `accessTokenEnv`, and the `proxy_alerts` channel
  `*_env` fields; the `serverless_function` Azure and GCP credential fallbacks
  move to `FERRUM_PLUGIN_SECRET_AZURE_FUNCTIONS_KEY` and
  `FERRUM_PLUGIN_SECRET_GCP_CLOUD_FUNCTIONS_BEARER_TOKEN`. Foundry's
  `ai_semantic_firewall`, `ai_stream_router`, `api_chargeback_sink` and
  `proxy_alerts` templates now name `FERRUM_PLUGIN_SECRET_*` variables, and a
  unit test pins every template reference to the namespace. The plugin-defaults
  contract keeps 74 admissions and seven exact rejections: `ai_stream_router`
  now gets Edge's unset-variable refusal (``provider "openai-streaming"
  `api_key` references a `FERRUM_PLUGIN_SECRET_<NAME>` env variable that is
  not set``) and `proxy_alerts` names the renamed variable. `ai_semantic_firewall`
  resolves its key lazily and `api_chargeback_sink` on activation, so both
  templates are still admitted without the variable set.
- **External identity headers** (ferrum-edge#6082, PR #6088).
  `X-Consumer-Username` now carries only a mapped Consumer's username, and an
  external identity is sent as the gateway-owned `X-Authenticated-Identity`.
  Edge refuses `X-Authenticated-Identity` as a configured header destination
  (`request_transformer`, `claim_headers` and similar) at config load. Foundry
  displays neither header and sets neither in any template or guided field; a
  raw JSON plugin config that names it gets Edge's `400`, shown as returned.
  The trusted-proxy identity headers between the identity proxy and the BFF are
  unrelated and unchanged.
- **LDAP `consumer_mapping` removed** (PR #6088). `LdapAuthConfig` drops the
  option and Edge refuses a config that still sets it. Foundry's `ldap_auth`
  template never set it and no guided form models it; a unit test keeps it out.
- **Per-source quotas and MCP sessions** (PR #6079). `rate_limiting` adds
  `ipv6_prefix` (1–128, default 64; `128` restores per-address keys), which the
  guided rate-limiting editor now models
  ([plugin schemas](plugin-schemas.md#current-schema-notes)). `mcp_gateway` adds
  `sessions.max_sessions_per_principal` (minimum 1, default 128, at most
  `sessions.max_sessions`), and a full session store now refuses a new session
  instead of evicting another principal's. `body_validator` refuses
  `grpc_max_decompressed_size_bytes: 0`. No Foundry template sets either of the
  last two, and both stay with the raw JSON editor and Edge admission.
- **Namespace-scoped operator backend TLS references** (ferrum-edge#6092,
  PR #6094). Where the admin `ns` claim is enforced — as in this qualification,
  which runs with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` — an `operator`
  creating or updating a proxy or upstream may set
  `backend_tls_client_cert_path`, `backend_tls_client_key_path` and
  `backend_tls_server_ca_cert_path` only to inline PEM, `system://`, or a
  `k8s://` Secret in the addressed namespace. Anything else is refused with
  `400` before it is loaded; values already stored are kept, and `admin`
  tokens are unaffected. The proxy and upstream forms state the rule beside
  those fields. They do not refuse locally, because Foundry cannot tell
  whether a gateway enforces the claim; Edge's refusal is shown as returned.
  No gateway contract, seed or journey writes these fields.
- **gRPC and WebSocket protocol-flavor refusals** (ferrum-edge#6087,
  PR #6090). A native gRPC or WebSocket request on a route whose
  authentication or admission plugins cannot run on that flavor gets `403`
  (`Request protocol not permitted on this route`) or `PERMISSION_DENIED`,
  logged with `rejection_phase: "route_protocol_admission"`. This is
  data-plane behavior; Foundry issues no gRPC or WebSocket request, and its
  critical journeys use plain HTTP. Client `Connection` nominations are now
  resolved at ingress (#6090); no Foundry journey sends one.
- **Helm chart ServiceAccounts** (ferrum-edge#6096, PR #6084). The
  `ferrum-mesh` chart's workload identities change. Foundry's docs and starter
  reference no Edge Helm chart.

The plugin registry and `PluginConfigBase` are unchanged, so the canonical
catalog keeps its 82 plugins. The sensitivity source file is byte-identical to
9bd4d5f9 (Git blob `827bf3a7c998c7ea9c995093ab38320facbd072a`, raw SHA-256
`47136b600b12ab4c11db7d366e2c70e82a5079dbc61f2a625d071171a74c64e5`), so the
table is unchanged and `PLUGIN_SENSITIVITY_SOURCE` now names 25b37395. The
`RateLimitingConfig` guided schema change is described in
[Qualification evidence](#qualification-evidence).

### Admin API changes in v0.9.16 through v0.9.20

Edge published v0.9.17 (2026-10-10), v0.9.19 (2026-10-27) and v0.9.20
(2026-11-03 UTC); v0.9.16 and v0.9.18 were tagged but not published. Most of the
changes are data-plane, mesh, Gateway API and per-plugin runtime hardening.
The changes on surfaces Foundry writes or reads are:

- **Closed plugin configuration** (ferrum-edge#6616). Every built-in plugin
  config refuses unknown keys at every depth, and many plugins add bounds or
  refuse values that could never match. The plugin-defaults contract submits
  every template unmodified to v0.9.20: 74 are admitted and the same seven
  are refused with exact diagnostics, as on v0.9.15. Only the `kafka_logging`
  refusal's wording changed: it now also names `FERRUM_KAFKA_ALLOWED_BROKERS`,
  an allow-list of trusted brokers that admits the plugin under a restrictive
  egress policy.
- **Cleartext endpoints off loopback** (ferrum-edge#6617). `opa`,
  `serverless_function`, `otel_tracing` and `workload_metrics` refuse an
  `http://` endpoint other than a `127.x.x.x` or `[::1]` literal unless the
  plugin sets `allow_plaintext: true`; the AI embedding and approval endpoints
  and `load_testing` fan-out have similar rules. The `opa` template now points
  at an `https://` OPA host; the other templates already used loopback or
  `https://` endpoints.
- **Association precondition** (ferrum-edge#6744). See
  [above](#the-edge-release-to-pair-with). Foundry already sends
  `expected_proxy_ids`, and the capability parity probes send it on the
  plugin-config `DELETE`.
- **Namespace bound** (ferrum-edge#6091, #6093, #6095). An admin token's `ns`
  claim always bounds its authority, even when
  `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=false`; scoped `/health` and `/status`
  answer the tenant tier. The BFF's namespace route ceiling already matches
  (see [authentication](authentication.md#namespace-route-ceiling)), and
  capability parity checks both principals against the pinned gateway.
- **Gateway material references** (ferrum-edge#6092 residual, PR #6316). For
  an `operator` token that carries an `ns` claim, backend TLS references and
  the TLS-material plugin fields admit only inline PEM, `system://` or a
  `k8s://` Secret in the addressed namespace, and plugin fields that name a
  gateway file path or native library setting (`geo_restriction` `db_path`,
  `kafka_logging` `ssl_*_location`, `api_chargeback_sink` `spool.dir`,
  `body_validator` `protobuf_descriptor_path`, and others) are refused. Admin
  tokens are unaffected. Foundry does not refuse these locally; Edge's `400`
  is shown as returned.
- **Consumer credentials.** `keyauth` keys need at least 16 non-whitespace
  characters (ferrum-edge#6577), `jwt` secrets 32 and must be unique per
  namespace (ferrum-edge#6865), shared `keyauth`, `basicauth` and `mtls_auth`
  credentials are refused (ferrum-edge#6572), and renaming a Consumer that an
  `access_control` config names is refused with `409` (PR #6873). Foundry's
  forms submit what the operator enters and show the refusal as returned. The
  demo seed's API keys grow from 8 to 17 characters; the contract, starter and
  journey keys already met the floor.
- **Projection rules.** Operator reads mask more plugin-config values (see
  [Qualification evidence](#qualification-evidence), item 3), so a failed
  write no longer echoes them either.
- **Guided schemas.** `key_auth`, `rate_limiting`, `cors` and
  `prometheus_metrics` components changed as described in
  [plugin schemas](plugin-schemas.md#review-history).
- **`mcp_gateway`** gates prompts and resources by policy
  (`policy.default_prompt_action`, `default_resource_action`, `prompts`,
  `resources`); those keys are refused in `transparent_proxy` mode, so
  Foundry strips them with the other aggregate-only keys when the editor
  switches mode. Per-server `forward_client_credentials` is aggregate-only too
  and stays with the JSON editor.

The gateway contract, capability parity, the Deployment Starter and the
critical journeys exercise the admin routes Foundry calls against v0.9.20.
ConfigSync, mesh, Gateway API and data-plane changes have no Foundry admin
contract.

### Admin API changes in v0.9.21

Edge v0.9.21 (published 2026-11-22 UTC) follows v0.9.20 directly. The changes
on surfaces Foundry writes or reads are:

- **Non-admin TLS-material, destination-path, and trigger-operand redaction**
  (ferrum-edge#7054, #7060). Non-admin reads withhold stored backend TLS
  private keys, inline TLS private-key material and certificate-plus-key
  bundles, non-trivial destination paths (`request_mirror` `mirror_path`,
  `mesh_route_dispatch` `rules.*.rewrite.uri`), and plugin trigger `header`,
  `query`, and `cookie` comparison operands, and non-admin plugin-config writes
  reserve the exact `[REDACTED]` literal in any string. Foundry's
  `PLUGIN_SENSITIVITY` table syncs all 16 updated plugins (`#728`), and
  `scripts/gateway-contract-smoke.mjs` asserts that the pinned gateway refuses
  the reserved `[REDACTED]` literal in `otel_tracing`'s `service_name`.
- **Consumer credential `If-Match` preconditions** (ferrum-edge#7393). Indexed
  credential deletes now evaluate `If-Match` against the consumer `ETag`,
  returning `412` on staleness instead of `400`.
- **External-identity trigger predicates** (ferrum-edge#7417).
  `PluginTriggerMatch` gains `external_identity` and
  `external_identity_authority`, already modelled in `src/api/types.ts` and
  `TRIGGER_VISIBLE_PREDICATES` (#737).
- **Removed unused/deprecated fields.** `pool_max_requests_per_connection` on
  proxies (#7218) and `discovery.hide_denied_items` on `mcp_gateway` (#7136)
  are rejected as unknown keys; Foundry already omits/strips both (#712).
- **`request_mirror` cleartext egress** (GHSA-gcwp-xp94-4pcv, #6659). Cleartext
  `http` targets off loopback require `allow_plaintext: true`; Foundry's
  template already points at `127.0.0.1`.
- **Database mTLS DNS admission fence.** Detailed `/health` may report
  `database.mtls_dns_admission_fence`, surfaced on the Status page (#734).

## Evaluated and rejected

No Edge image is currently rejected (`edge.rejected_images` is empty). A
rejected digest may appear only in history files (`CHANGELOG.md`, this page,
`compatibility.json`, published release notes);
`scripts/supported-pairing.test.mjs` fails if any other file names it.

## History

| Period | `edge.image` | What happened |
| --- | --- | --- |
| Until #409 | `ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d` — development build `main-b96cfaadd41a676d39a409d47b48e0b0588fa86e` (2026-08-27) from Ferrum Edge `main`, never a published release | The interim pin. It predates ferrum-edge#4611 and `5db1d77a8`: a proxy-scoped plugin configuration did not protect the route until the proxy was updated by hand, and a second namespace could not reuse an id (`409`) |
| #385 evaluation | v0.9.5, `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` | Recorded as rejected: the Deployment Starter walkthrough and the namespace-isolation journey failed on Foundry assertions encoding pre-0.9 behavior (ferrum-edge#4611, `5db1d77a8`), not Edge defects ([CI run 35901872338](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/35901872338)) |
| #409 until the v0.9.7 pin | v0.9.5, the same digest | Foundry aligned with the Edge 0.9.x semantics, and v0.9.5 moved from `edge.rejected_images` to `edge.image`. It lacked ferrum-edge#5661, so it was the CI pin, never a supported pairing |
| [#439](https://github.com/ferrum-edge/ferrum-foundry/pull/439) until the v0.9.8 pin | v0.9.7, `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a` | The first published Edge release after v0.9.5 and the first with ferrum-edge#5661. Foundry [v0.2.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.2.0) paired with it |
| [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498) until #512 | v0.9.8, `ferrumedge/ferrum-edge@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385` | Admin API unchanged from v0.9.7 ([Admin API changes in v0.9.8](#admin-api-changes-in-v098)). Foundry [v0.3.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.3.0) paired with it |
| [#512](https://github.com/ferrum-edge/ferrum-foundry/pull/512) until #524 | v0.9.9, `ferrumedge/ferrum-edge@sha256:83bb4de2ea264d5bed18d8f01f94e0e17a29b43aa1458b8984a0e9e1e784ede6` | Qualified, with no Foundry release paired. It added the MCP tool catalog read, `allow_path_parameters`, and the masked-placeholder write refusal ([Admin API changes in v0.9.9](#admin-api-changes-in-v099)) |
| [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) through the v0.4.0 release | v0.9.10, `ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc` | Includes ferrum-edge#5954 ([MCP security fixes in v0.9.10](#mcp-security-fixes-in-v0910)). Foundry [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0) paired with it; full evidence in [the immutable record](release-notes/v0.4.0.compatibility.json) |
| [Foundry v0.5.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.0) | v0.9.11, the c764 distribution recorded in [the immutable record](release-notes/v0.5.0.compatibility.json) | Qualified and released; source `7ab9ddb732ebd890fb02928d6e4b22470ceab3f7`, image `ferrumedge/ferrum-foundry@sha256:079db008f6e45e721c2b6636be94980c67b69faff963eace2de7be2232a7eb9b`; all release facts remain in that record |
| [Foundry v0.5.1](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.1) | Published v0.9.12, `ferrumedge/ferrum-edge@sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4` | Qualified and released from `1dc43bd1bbd4c2c89ca14e2a603aa478ab1a0d18`; original qualification and actual image/publication evidence are preserved in [the immutable record](release-notes/v0.5.1.compatibility.json) |
| [Foundry v0.5.2](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.2) | Published v0.9.13, `ferrumedge/ferrum-edge@sha256:6caa0987adb4c0a3a368fcd800bb0459cff3d3e219522e2e9c56280205862e50` | Qualified and published; full evidence in the [immutable v0.5.2 record](release-notes/v0.5.2.compatibility.json) |
| [Foundry v0.5.3](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.3) | Published v0.9.14, `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` | Qualified and published; full evidence in the [immutable v0.5.3 record](release-notes/v0.5.3.compatibility.json) |
| [Foundry v0.5.4](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.4) | Published v0.9.14, the same `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` | Qualified and published; full evidence in the [immutable v0.5.4 record](release-notes/v0.5.4.compatibility.json) |
| [Foundry v0.5.5](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.5) | Published v0.9.15, `ferrumedge/ferrum-edge@sha256:29b468dfeea13b1ecaac8dfbc7e019f310e71e647611d43800a1dc64436eaca3` | Qualified and published; full evidence in the [immutable v0.5.5 record](release-notes/v0.5.5.compatibility.json) |
| [Foundry v0.5.6](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.6) | Published v0.9.20, `ferrumedge/ferrum-edge@sha256:32a0b0574bb2ed105d315888fab12e33242e1cec3ae9f1ae34c1fb4d0c9a2689` | Qualified and published; full evidence in the [immutable v0.5.6 record](release-notes/v0.5.6.compatibility.json) |

Source commits, platform digests, release runs and Foundry image digests for
the rows above are preserved in the immutable records; for v0.5.5 and earlier
also in the
[v0.5.5 tagged copy of this page](https://github.com/ferrum-edge/ferrum-foundry/blob/v0.5.5/docs/compatibility.md#history),
and for v0.5.6 in [The published pairing](#the-published-pairing).

## Tested support

This is the qualification envelope v0.5.6 passed against Edge v0.9.20 (v0.5.5
passed it against Edge v0.9.15 without the production identity path row). The
gates run on every pull request and again before publication against
`edge.image`. The machine-readable `tested` dimensions describe the qualified
envelope; they do not qualify other Edge images or gateway modes.

| Dimension | Qualification target | Evidence gate |
| --- | --- | --- |
| Gateway mode | `database` on SQLite, admin writes enabled, admin JWT with audience and `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` | Pinned Gateway Contract, Deployment Starter, Critical Journeys, Container Gate |
| Read-only admin API | `database` started with `FERRUM_ADMIN_READ_ONLY=true` | Pinned Gateway Contract (capability parity, read-only half) |
| Database backends | `database` on PostgreSQL, on MySQL and on MongoDB (a one-member replica set), from the digest-pinned images in `scripts/gateway-modes/up.sh`, each from an empty database | Gateway Modes (postgres), (mysql), (mongodb): seed twice and verify the canonical backup, writable capability parity, every page read through the BFF |
| Control plane | `cp` on SQLite, distributing to a data plane over plaintext gRPC | Gateway Modes (cp-dp): a proxy created through Foundry on the CP is served by the DP's admin API and routed by its data plane within a bounded wait, each side reports the other connected, writable capability parity on the CP, every page read through the BFF, the metrics placeholders |
| Read-only gateway modes | `file` (a fresh configuration file), the `dp` of that CP + DP pair, and a `mesh` sidecar on a local mesh document (file protocol, a throwaway root and X.509-SVID) | Gateway Modes (file), (cp-dp), (mesh): read-only capability parity, every page read through the BFF, the metrics placeholders |
| Roles | `viewer`, `operator`, `admin` | capability parity (every surface and the launch reads, per role); critical journeys through the identity proxy |
| Authentication | `trusted-proxy` behind the starter's nginx identity proxy, with the shared group-to-role policy | Deployment Starter, Critical Journeys |
| Production identity path | The starter's `production` profile as shipped: TLS nginx and oauth2-proxy (OIDC with PKCE S256, `--trusted-proxy-ip` set to the stack's subnet) against a mock OIDC provider, with no gateway | Starter Production Profile |
| Deployment path | `deploy/starter` (Compose) with the production Foundry image | Deployment Starter, Critical Journeys |
| Browser | Chromium bundled with `@playwright/test` 1.65.1, Desktop Chrome profile | Critical Journeys |
| Other browser engines | Firefox (Desktop Firefox profile) and WebKit (Desktop Safari profile) bundled with the same `@playwright/test` | Critical Journeys (firefox), Critical Journeys (webkit): the same journeys as Chromium |
| Container platforms | `linux/amd64`, `linux/arm64` | Container Gate (both builds start and serve a protected request) |
| BFF Node.js | 22.22.2 and 24.15.0 minimums (the image ships 24) | Quality Gate matrix |

The production identity path row and its gate are new for v0.5.6: v0.5.5 was
not qualified on it. It adds a required gate, not a
dimension of the machine-readable `tested` record, which describes the
gateway, roles, authentication mode and deployment the gates run and stays
as v0.5.5 recorded it, apart from the Playwright version. The Browser row
and `tested.browsers` name the `@playwright/test` version `package-lock.json`
locks, which the Critical Journeys install (v0.5.5 ran 1.63.0), and
`scripts/supported-pairing.test.mjs` fails when they differ.

The database backend, control plane, read-only gateway mode and other browser
engine rows are new for 1.0.0 and gate it (`QUALIFICATION_JOBS` in
`scripts/hosted-qualification.mjs`); no earlier release was qualified on them.
The machine-readable `tested` record gains them in the 1.0.0 release PR.
"Every page read through the BFF" is `server/routes/page-reads.gateway.test.ts`.
Each list and summary read a Foundry page sends, as an unrestricted and as a
namespace-scoped administrator, must answer `200` with the fields the page
consumes (the list envelope, the metrics gateway block, the mesh snapshot
shapes, the runtime overlay through the same rules as its decoder). Where the
job's fixture leaves a feature off, the read must give exactly the recorded
`404` or `503` instead, per mode: API specs, audit and gateway trust need a
configuration database, the mesh observability reads are served by the mesh
sidecar (slice drift by the control plane), and no fixture configures mesh
federation or a waypoint. Losing a read the fixture enables fails. It also
opens the first row of each collection as the editors do, requires the
fixture's proxy in the list where the job created one, checks that `/health`
is ready in the expected mode, and that `adminMetricsReporting` hides exactly
the `/admin/metrics` values the gateway serves as placeholders (Edge's
no-proxy-state skeleton on a control plane). It reads; it does not render the
pages, so the mesh views are qualified at the API boundary on a mesh sidecar
with no control plane, not against a populated mesh, and the federation and
waypoint views only for their not-served state.

### Tested scale

Scale claims stop at what has been measured. These are the 1.0 limits, not
targets:

- **Against the real gateway:** 1,000 proxies and 1,000 upstreams in one
  namespace, seeded and read back through Foundry's BFF on every Pinned
  Gateway Contract run (`server/routes/scale.gateway.test.ts`, step "Measure
  1,000-record collections through the BFF"). The run asserts that every page
  and every record comes back and writes requests, bytes and elapsed time to
  the job summary. Measured on the v0.9.21 pin (hosted `ubuntu-26.04` runner,
  [run 46069000787](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/46069000787)):

  | Read through the BFF | Requests | Response bytes | Elapsed |
  | --- | ---: | ---: | ---: |
  | Proxy list, first page (50 rows) | 1 | 75.2 KB | 19 ms |
  | Proxy list, last page (50 rows) | 1 | 75.2 KB | 10 ms |
  | Open one proxy | 1 | 1.5 KB | 4 ms |
  | Every proxy (pages of 250) | 4 | 1.5 MB | 73 ms |
  | Every upstream (pages of 250) | 4 | 485 KB | 38 ms |

  Seeding both collections with one `POST /batch` took 433 ms. Elapsed is
  measured around in-process requests to the BFF (`app.inject`), from the
  request to the decoded response: it includes the BFF's own handling and
  JSON decoding as well as the gateway round trip, on one hosted runner. It
  is not browser latency, and it is evidence for this envelope, not a
  guarantee for larger ones. The complete traversals use Foundry's own
  `collectBoundedPages` and must return exactly the seeded ids. The other
  journeys use the demo seed and contract fixtures (tens of resources across
  two namespaces).
- **Request budget, synthetic:** `src/api/dataLoadingBudget.test.ts` counts
  requests and response bytes at 500 and 50,000 records per collection against
  a synthetic gateway ([data-loading.md](data-loading.md)). That is not browser
  latency, and no latency is claimed.

## Capability parity

`scripts/capability-parity-contract.mjs` asks the pinned gateway the same
questions the UI's capability model (`src/lib/capabilities.ts`) answers, as
each role, and fails on any disagreement. It also checks that every role gets
real collections for the launch surfaces, and that a read withheld from a role
is an explicit `403` naming that role. The writable half runs inside
`npm run test:gateway-contract`; the read-only half runs against a second
container of the same image started with `FERRUM_ADMIN_READ_ONLY=true`. See
[capabilities.md](capabilities.md#drift) for what it probes and how.

## Admin API coverage

[Admin API coverage](admin-api-coverage.md) lists every operation in the
paired Edge release's `openapi.yaml` and says whether the UI uses it, the BFF
forwards it unused, or the BFF denies it, and whether a namespace-scoped session
may reach it. `scripts/admin-api-coverage.test.mjs` checks the table against
the BFF and the recorded `edge.source_commit`, and the Pinned Gateway Contract
job checks it against the spec, so a pin move cannot add an unclassified
operation silently.

## Best-effort

Expected to work because nothing Foundry does depends on them, but not run in
CI. Report problems; they do not block releases.

- Other Chromium-based browsers, and Firefox and Safari releases other than
  the engines Playwright bundles (the journeys run Playwright's Firefox and
  WebKit builds, not the branded browsers).
- A mesh data plane that receives its slice from a control plane (native,
  xDS or Kubernetes protocol) rather than a local mesh document.
- Kubernetes or any other deployment that reproduces the documented
  trusted-proxy contract ([deployment.md](deployment.md)).
- Static-token authentication (development only).

## Not qualified

These are deliberate limits of what a Foundry release qualifies and supports, stated for
every release from 1.0.0 onward; a change to them is recorded here and in the
release notes.

- `node_agent` gateway mode. It needs the Kubernetes API, eBPF capabilities
  and the `-ebpf` image variant, none of which a CI runner provides. Foundry
  treats it as a read-only gateway without proxy state
  ([capabilities.md](capabilities.md)): every configuration write and the
  managed TLS material are read-only, and configuration export is unavailable;
  the fleet operations (the backend-capability refresh and the mesh egress
  dry-run) are unavailable, with Edge's typed `503` as the reason; the
  ungated actions (TLS rotation and validation, and BFF settings) stay
  available to an unrestricted operator or administrator, as Edge serves them;
  and the Metrics page and Dashboard show its zeroed runtime values as not
  reported. The mock admin gateway (`MOCK_GATEWAY_MODE=node_agent`) reproduces
  those answers; no real node agent runs in CI.
- Support applies to published releases only: any published Foundry release
  against an Edge release other than the one its immutable record names
  ([History](#history)) is unsupported, as is any unpublished build. Hosted
  qualification is a separate gate before publication: the prepared release
  (`status: "candidate"` in [`compatibility.json`](compatibility.json)) must
  pass it, with the run recorded in `qualification`, before it can be tagged
  (see [The Edge release to pair with](#the-edge-release-to-pair-with)).
  Previous successful qualification cannot qualify a moved pin.
- For the version in `foundry.version`, any Ferrum Edge release other than
  `edge.release` and any Ferrum Edge image other than `edge.image`, including
  the eBPF variants of the same release.
- Browser latency, more than one operator editing at scale, and anything above
  the [tested scale](#tested-scale).

Guided plugin editing covers four plugins (`key_auth`, `rate_limiting`, `cors`,
`prometheus_metrics`); every other plugin is edited as raw JSON and admitted
by Edge ([plugin schemas](plugin-schemas.md)). Seven shipped plugin templates
are refused by the gateway until the operator supplies an environment-specific
value ([plugin defaults](plugin-defaults.md#templates-that-need-operator-input)).

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. Every published release since, v0.9.8
through v0.9.21, retains it. It is not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag.
The v0.9.15 contract gate confirmed the strong item tags for v0.5.5, and the
v0.9.20 contract gate confirmed them for v0.5.6.
With a strong
tag, a full-replacement save or a detail-page delete is atomic: a writer that
commits between the guard's verification read and the write is refused
with `412` and nothing is written.

The contract `scripts/concurrent-edit-contract.mjs` requires the pinned gateway
to issue the tags, refuse a stale and an invented tag with `412`, and refuse a
malformed `If-Match` and one on a create with `400`. See
[concurrent-edits.md](concurrent-edits.md).

### Guarded-write initial-validator policy (#542)

`guardedReplace` and `guardedRemove` require the initial fresh verification
read to return one nonempty quoted visible-ASCII strong validator; without one
they send no `PUT` or `DELETE`. These guarded operations therefore have no
initial unconditional fallback on older gateways, modes without a database, and
cached reads (`X-Data-Source: cached`), including cached reads from the paired
release. See [the precise scope](concurrent-edits.md#without-a-tag).

## Checking against Edge main

The pin binds every gate above to a published Edge release, so none of them
sees a breaking change that has landed only on Edge `main`. The **Edge Main
Drift** workflow (`.github/workflows/edge-main-drift.yml`) fills that gap as
an early warning (ferrum-edge/ferrum-contracts#76). It runs weekly and on
`workflow_dispatch`, and is never a required check.

- **Which Edge.** The `latest` tag of `ghcr.io/ferrum-edge/ferrum-edge`, which
  Edge's Main Latest Image workflow moves only to a `main` commit whose push
  CI passed. The tag is resolved to its digest once; the digest must carry
  that workflow's keyless Cosign signature on `refs/heads/main`, and the Edge
  commit is the signed image's `org.opencontainers.image.revision` label,
  which must be on `main`'s history. The image can trail `main` by the
  commits not yet built; the report says how many.
- **What runs.** The guided plugin schema, plugin sensitivity and server-owned
  subset `traffic_policy` field comparisons against the Edge sources at that
  commit, plus the plugin trigger predicate lists Foundry redacts by
  (`TRIGGER_CLIENT_FIELD_PREDICATES` and `TRIGGER_VISIBLE_PREDICATES`, which
  have no pinned counterpart: v0.9.20 does not project triggers), and the
  Edge source parity tables (below)
  (`scripts/edge-main-drift.mjs`;
  only content is compared, since the recorded refs never name a `main`
  commit), then the Pinned Gateway Contract job's gateway steps with
  `FERRUM_EDGE_IMAGE` set to the Edge `main` image, then the editors'
  unchanged proxy and upstream saves over the seeded namespace
  (`src/api/editorSave.gateway.test.ts`: `mergeFormUpdatePayload` output, as
  the detail editors send it, with `If-Match`). The editor saves catch a field
  the payload builders add that Edge no longer accepts (#701); the contract
  smoke writes fixture spreads and cannot. `scripts/edge-main-drift.test.mjs`
  derives the gateway step list from `ci.yml`, so a step added to or removed
  from the Pinned Gateway Contract job fails it until this workflow follows,
  and fails when a copied step's script differs.
- **What it reports.** One issue labelled `edge-main-drift` whose body starts
  with `<!-- edge-main-drift -->`, opened or updated on a finding, and also
  when the check could not run (an unresolvable or unsigned image, a failed
  install, a run that stopped early), and closed only by the next clean run.
  An issue without that marker is never edited or closed. It names the Edge
  commit, the image digest, how far `main` has moved past it, and the commit
  of ferrum-contracts' `main_branch_delta` (the contracts record of what Edge
  `main` changes) with whether it covers the checked commit. Only the issue
  job holds `issues: write`, with the repository's own `GITHUB_TOKEN`.

A finding is not a qualification result. It is time to ship a compatible
Foundry release before Edge releases the change.

### Edge source parity

Three decisions Foundry takes from Edge's source, not from an admin API
answer, are transcribed with the commit they were read at and re-read by
`npm run check:edge-source-parity` (`scripts/edge-source-parity.mjs`) in the
Pinned Gateway Contract job, and against Edge `main` by the Edge Main Drift
workflow:

| Foundry table | Edge source | What a stale copy breaks |
| --- | --- | --- |
| `PLUGIN_DEFAULT_PRIORITY` (`src/lib/pluginChainOrder.ts`) | `BUILTIN_PLUGIN_PARITY_META` in `src/plugins/builtin_parity.rs` | Effective policy orders each proxy's chain by it, which decides whether a Consumer is authenticated before another plugin can refuse it |
| `EDGE_NAMESPACE_SCOPED_KINDS` and the route digest (`server/proxy-path.ts`) | `namespace_scoped_resource_kind` (its arms, and the whole function by digest), `is_namespace_scoped_route`, `ceiling_global_route_is_allowed` and `ns_claim_global_route_is_allowed` in `src/admin/mod.rs` | The BFF's namespace route ceiling: a scoped request reaches Edge only on a route class Edge treats as namespace-scoped |
| `METRICS_MODES` and `NO_PROXY_STATE_MODES` (`src/lib/adminMetricsReporting.ts`) | `ADMIN_METRICS_MODES` and the positive mode list of the `contract_fixtures` branch that assigns `proxy_serving_fixture` in `src/admin/metrics.rs` | Which `/admin/metrics` values the Metrics page and Dashboard hide as placeholders |

The parsers fail closed on a shape they do not understand. The route
functions are compared by digest (comments removed, whitespace collapsed), so
any change to them, an early return around unchanged match arms included,
means re-reading them. Behaviour is checked as well:
`src/api/effectivePolicy.gateway.test.ts` (Pinned Gateway Contract step
"Verify effective policy against the gateway") compares `analyzeProxyPolicy`
with the data plane for a fixture of global, proxy-scoped and proxy-group
`key_auth` and `access_control` plugins, including a shadowed global
`key_auth` and an ACL whose only allow-list is `allowed_external_identities`;
an authenticator pair (a `key_auth` on `Authorization` that runs before a
`jwt_auth`) in `single` and in `multi` auth mode, where a JWT-only Consumer is
refused in the first and admitted in the second; and a TCP stream proxy, where
HTTP-only authentication is not counted and the global ACL closes every
connection. Multi-instance authentication on a TLS stream listener (two
`mtls_auth` hooks that must both accept a certificate) is modelled as
request-dependent and unit-tested; the contract gateway has no frontend TLS
for a client-certificate fixture.

## Changing the pairing

Moving the Edge pin is a re-qualification, not a tag edit:

1. Choose a **published** Edge release that meets the
   [requirements](#the-edge-release-to-pair-with). Read its multi-architecture
   index digest and per-platform manifest digests from the registry.
2. Fill `edge.release` in `docs/compatibility.json`, and move `edge.image`,
   `edge.source_commit`, and `edge.platform_manifests` to the same release.
   Update the `demo-gateway` image in `deploy/starter/compose.yaml`, the
   local-run command in `CLAUDE.md`, and the tables on this page.
   `scripts/supported-pairing.test.mjs` fails until they agree with the record,
   and reports any other file that still names a different Edge image (the
   draft `docs/release-notes/UNRELEASED.md` must name none).
3. Re-read Edge's plugin configuration projection table at the new
   `edge.source_commit`, update `src/api/pluginSensitivity.ts` to match, and
   record that commit in `PLUGIN_SENSITIVITY_SOURCE`. Recheck read/write behavior
   for masked secrets and add endpoint or authorization probes for new admin routes.
   `scripts/plugin-sensitivity-drift.test.mjs` fails until the recorded commit
   is the pinned one, and `npm run check:plugin-sensitivity` (Pinned Gateway
   Contract) fails while the table differs from Edge's. Likewise re-read the
   `readOnly` properties of `SubsetTrafficPolicy` in `openapi.yaml` (and
   `Upstream::validate_operator_provided_fields`), bring
   `SUBSET_TRAFFIC_POLICY_SERVER_OWNED` in `src/api/subsetTrafficPolicy.ts` in
   line and record the commit in `SUBSET_TRAFFIC_POLICY_SOURCE`:
   `scripts/subset-traffic-policy-drift.test.mjs` fails until it is the pinned
   one, and `npm run check:subset-traffic-policy` fails while the list differs.
   Likewise re-read the three [Edge source parity](#edge-source-parity)
   tables and record the commit in `PLUGIN_CHAIN_ORDER_SOURCE`,
   `EDGE_NAMESPACE_ROUTE_SOURCE` and `ADMIN_METRICS_SOURCE`:
   `scripts/edge-source-parity.test.mjs` fails until each is the pinned one,
   and `npm run check:edge-source-parity` fails while a table differs.
4. Review the actual hosted schema producer artifact before changing schema
   refs/digests, and adopt only a qualified, published canonical contract tag.
   Record pending qualification until every existing gate passes.
   `PLUGIN_SCHEMA_SPEC.ref` must become the new `edge.source_commit` even when
   no digest changed: `scripts/plugin-schema-drift.test.mjs` and
   `npm run check:plugin-schemas` fail until it does.
5. Open a pull request. Every gateway-backed gate (contract, capability
   parity, starter, critical journeys, container) runs against the new image.
   A failure is a compatibility finding to review, not a test to relax.

If the candidate fails, restore the previous `edge.image`, record the candidate
in `edge.rejected_images` with its finding and CI run, and add it to
[Evaluated and rejected](#evaluated-and-rejected).

## The 1.0.0 release pull request

Work that waits only on an upstream release, recorded here so the pull
requests that pin Edge 1.0.0, re-pin ferrum-contracts and prepare Foundry
1.0.0 carry it out instead of rediscovering it. Each item is code, not a
known limitation; none may be dropped from those pull requests.

**The Edge 1.0.0 pin.** Edge is adding four Admin API capabilities. Foundry
adopts each one in the pin pull request, at these call sites:

- **`q=` list search.** Searching a list page today loads the whole
  collection and filters it in the browser (`filterAndPage` in
  `src/lib/collectionSearch.ts`) on `src/routes/proxies/index.tsx`,
  `src/routes/upstreams/index.tsx`, `src/routes/consumers/index.tsx`,
  `src/routes/plugins/index.tsx` and `src/routes/api-specs/index.tsx`, each
  switching from its one-page hook to the whole-collection one (`useProxies` /
  `useAllProxies` in `src/hooks/useProxies.ts`, and the same pairs in
  `useUpstreams.ts`, `useConsumers.ts`, `usePlugins.ts` and `useApiSpecs.ts`).
  For the future Edge 1.0 re-pin (Edge PR #7546 `b020a5f`, proposed and not
  yet released), `q=` applies only to proxies, consumers, upstreams and plugin
  configs (`list` in `src/api/proxies.ts`, `consumers.ts` and `upstreams.ts`,
  `listConfigs` in `plugins.ts`), keeping paging server-side. Keep API specs
  (`src/api/apiSpecs.ts`, `src/routes/api-specs/index.tsx`) on the existing
  title / spec ID / proxy ID / tag matcher and separate `items`/`next_offset`
  traversal until a parity filter ships (`title_contains` alone does not
  preserve it). Preserve proxy `backend_host` and plugin `proxy_id` lookups
  where server `q=` support differs, or require a deliberate, documented and
  tested intentional change before switching to server `q=`. Account for and
  test whitespace and ASCII-vs-Unicode differences against client filtering.
- **`applies_to_proxy=`.** Effective policy needs every global, proxy-scoped
  and proxy-group configuration that can reach one proxy, so it reads the whole
  plugin collection (`useAllPluginConfigs` → `plugins.listAllConfigs` in
  `src/hooks/usePlugins.ts` and `src/api/plugins.ts`) for
  `analyzeProxyPolicy` on `src/routes/proxies/$proxyId.tsx` and for each proxy
  on `src/routes/consumers/$consumerId.tsx`. Read the proxy's configurations
  with `applies_to_proxy=` instead (extend `plugins.listConfigsForProxy` and
  `useProxyPluginConfigs`, which today send `proxy_id=`), keep refusing a
  response the filter did not narrow, and keep `buildPluginAttachmentIndex`'s
  scope merge as the check on what Edge returns. The proxy list's per-row
  policy summary (`src/routes/proxies/index.tsx`, `useBoundedPluginConfigs`)
  stays on the bounded collection read.
- **A collection revision in `pagination`.** `collectBoundedPages` in
  `src/api/pagination.ts` assembles a complete collection from pages read at
  different moments. In the proposed Edge PR #7546 (`b020a5f`, not yet
  released), collection revision support applies only to proxies, consumers,
  upstreams and plugin configs (`collectAllPages` and their `listAll` callers
  inherit it; API specs keep their separate `items`/`next_offset` traversal).
  Scope stable non-empty revision checks and `if_revision` to those supported
  endpoints: send the first page's revision on subsequent pages and verify each
  page matches it to detect revision changes, doing a bounded restart or
  showing unknown on revision conflict. Standalone MongoDB writes the resource
  and change record separately, so a page can briefly reflect a write before
  its revision changes (replica sets support the strict revision guarantee).
- **`ids=`.** Rows on screen resolve their references one request per id:
  `useUpstreamReferences` → `upstreams.getReference`
  (`src/hooks/useUpstreams.ts`, `src/api/upstreams.ts`) and
  `useProxyReferences` → `proxies.getReference` (`src/hooks/useProxies.ts`,
  `src/api/proxies.ts`). Resolve them with one `ids=` read per page of rows.

In the same pull request: classify the operations the new `openapi.yaml`
adds in [Admin API coverage](admin-api-coverage.md) and move its marker
(Edge `main` already serves `HEAD` on `/live`, `/health` and `/status`);
bring the [Edge source parity](#edge-source-parity) tables in line (Edge
`main` narrows `config` to exactly `/config/export` and `gateway-trust` to
exactly `/gateway-trust/status` in `namespace_scoped_resource_kind`); and
replace the managed TLS re-read guard in `replaceManagedRecord`
(`src/api/tls.ts`) with the atomic precondition Edge provides for managed
records.

**The ferrum-contracts re-pin.** Add a parity test of both exports of
`src/api/pluginSensitivity.ts` against the contracts
`plugin-config-sensitivity` vocabulary (ferrum-contracts#96): `PLUGIN_SENSITIVITY`
against its per-plugin rule table, and `KAFKA_SAFE_PRODUCER_PROPERTIES` (which
decides the producer property values left readable) against its Kafka safe
property list. Keep the existing Edge-source drift check beside it.

**The Foundry 1.0.0 release.** The release pull request records the
envelope the Gateway Modes and Critical Journeys engine jobs qualify (the
`tested` record and the qualification note in `compatibility.json`, which
names every job in `QUALIFICATION_JOBS`), then follows the four-step
sequence: the release pull request (record `candidate`, qualification
pending), a qualification-only pull request recording `main`'s push run, the
owner's `v1.0.0` tag, and the record pull request (status `released`, the
immutable `v1.0.0.compatibility.json`, the starter digest).
