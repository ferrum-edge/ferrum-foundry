# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer.
[`compatibility.json`](compatibility.json) is the machine-readable current
candidate record, and CI reads the gateway image from it.

**Record version 2, status: candidate; qualification: pending.** The Foundry
v0.5.6 candidate selects published Edge v0.9.20, the latest Edge release, and
canonical `contracts-edge-0.9.20` (#686). Foundry source, image and
publication CI fields are null; all four qualification identity fields are
null. This source preparation is not a release or a recorded qualification.
The latest published pairing remains Foundry v0.5.5 / Edge v0.9.15, preserved
byte-for-byte in [its immutable record](release-notes/v0.5.5.compatibility.json).
Earlier pairings and their immutable records are in [History](#history).

## The candidate pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | v0.5.6 candidate; previous release v0.5.5 | [Ferrum Edge v0.9.20](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.20) |
| Source commit | *release step*: null until publication | `e4a606a00352674daaef08636e3e359e6c48ba18`, immutable `v0.9.20` tag target |
| Image | *release step*: null until publication | `ferrumedge/ferrum-edge@sha256:32a0b0574bb2ed105d315888fab12e33242e1cec3ae9f1ae34c1fb4d0c9a2689` |
| Platforms | `linux/amd64`, `linux/arm64` qualification pending | `linux/amd64` `sha256:d3e3e7e8409d0583b23e0fa4eee4b85c7b20885a314d4ada2ca8aad66bd33e1c`; `linux/arm64` `sha256:406d8335e60f15ee024141762a7b280bea4abe76fef37ac26b65c45085ae7426` |
| CI evidence | Qualification pending; publication *release step* | [Edge release run 41590569525](https://github.com/ferrum-edge/ferrum-edge/actions/runs/41590569525), all 20 jobs successful; distribution evidence only |
| Published | *release step* | GitHub release 432463173, 2026-11-03 08:58:10 UTC |

Edge v0.9.20 is stricter than v0.9.15 about the plugin configuration Foundry
writes: every plugin config refuses unknown keys at every depth, and many
built-in plugins gained bounds and refusals. The changes Foundry reacts to are
in [Admin API changes in v0.9.16 through v0.9.20](#admin-api-changes-in-v0916-through-v0920).

## The CI pin

Every gateway-backed gate reads `edge.image`, the published v0.9.20 default
multi-architecture index above. Edge release `432463173` was published at
2026-11-03 08:58:10 UTC from tag commit
`e4a606a00352674daaef08636e3e359e6c48ba18`, after the main-push workflows on
that commit succeeded. Release run `41590569525` completed all 20 jobs
successfully, including signing, attestation and both release gates (Linux
GNU ABI and image attestation). The raw Docker Hub index bytes for both the
`0.9.20` and `v0.9.20` tags hash to the recorded index digest (read with the
OCI index media type and an anonymous pull token), and the two platform
manifests and the `linux/amd64` config were read from the registry by digest.
`edge.release.binary_sha256` records the seven published binary hashes; each
equals its GitHub API asset digest and its published `.sha256` sidecar.

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
`0.9.20-ebpf` and `0.9.20-ebpf-tools` variants are published but outside the
v0.5.6 qualification target.

The raw canonical OpenAPI at the immutable Edge source has SHA-256
`8fa7232d96e1094578dee03cfa1966a4fdd9df77b8e027a9625f56ce6bfd355e`.
Its `info.version: 0.2.0` is schema metadata, not either product's version.

## Qualification evidence

1. **Canonical adoption complete.** Published
   [contracts-edge-0.9.20](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.20)
   names `39da322083044c2e92617209e62983c92387f0ad`; release `432497834`
   was published at 09:34:12 UTC on 2026-11-03 after the main
   [Validate contracts run 41611708250](https://github.com/ferrum-edge/ferrum-contracts/actions/runs/41611708250)
   succeeded on that commit. The same 18 scoped files are taken byte-exact from
   the tag, and each Git blob matches. Only the two vocabularies and the
   complete canonical invalid-expectations file change. The plugin catalog
   keeps all 82 plugins; its provenance moves to v0.9.20, `ai_token_metrics`
   moves from priority 4100 to 4070 (so does `PLUGIN_PRIORITY`),
   `stdout_logging`'s registration failure policy becomes
   `keep_last_known_good`, `openapi_validator` records its proxy scope
   constraint, `request_transformer` adds the `websocket` protocol (handshake
   headers and query only), and several plugins list new phases. The stream
   plugin set Foundry mirrors (`src/lib/pluginProtocols.ts`) is unchanged.
   Provisioning values, both vocabulary schemas, the manifest schema and all
   12 manifest fixtures are unchanged. Shared manifest/report status remains
   EXISTING/implemented at Alloy owner
   `81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e`, whose availability stays
   unreleased.
2. **Guided schema static review complete.** At
   `e4a606a00352674daaef08636e3e359e6c48ba18`, `RateLimitingRuleConfig` is
   byte-identical to 25b37395; the other four component blocks changed and
   were re-read. `KeyAuthConfig` `key_location` also admits an ordered list of
   1 to 8 locations, which the guided editor declines and leaves to JSON.
   `RateLimitingConfig` adds `limit_by: service` and `max_state_entries`, and
   `CorsConfig` bounds its method and header lists at 128 entries and adds
   `allow_private_network`; the guided editor models all of these.
   `PrometheusMetricsConfig` adds two histogram bucket arrays, left to JSON.
   `PLUGIN_SCHEMA_SPEC.ref` moves to e4a606a0. The drift check compares the
   pinned hashes at `edge.source_commit`, and the hosted producer export checks
   them independently. [Plugin schemas](plugin-schemas.md#review-history)
   records the review.
3. **Sensitivity source re-read.** `plugin_config_projection.rs` changed
   (Git blob `827bf3a7c998c7ea9c995093ab38320facbd072a` to
   `d50b0d53b7a4ace7454a25a7e8034b4a8ea5c1a8`). `ldap_auth`
   `failover_ldap_urls` is an endpoint; `waf`
   `global_exemptions.header_present` values, `fault_injection`
   `match.headers` values, `mesh_route_dispatch` `request_transform` values,
   `request_transformer` rule values, `response_mock` match header and query
   values, and `ws_logging` `custom_headers` values are secret. Foundry's
   table follows rule for rule and `PLUGIN_SENSITIVITY_SOURCE` names
   e4a606a0. Edge's name heuristic for config keys narrowed to its listed
   rules; Foundry's name floor is unchanged and stays the broader of the two.
4. **Hosted pairing qualification pending.** The candidate pull request runs
   every gateway-backed gate against the new image; the run that qualifies the
   tagged source is recorded in `qualification` when the release is prepared.
5. **Foundry publication pending** (*release step*).

The database profiles, Node floors and `viewer` / `operator` / `admin` tiers are
unchanged. Like v0.5.2 through v0.5.5, this candidate includes the initial
untagged-write refusal of the adopted guarded-write policy #542 (see
[below](#guarded-write-initial-validator-policy-542)).

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; every published release since, v0.9.8
   through v0.9.20, retains it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5 and v0.9.7 through v0.9.20, has both:
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
   Starter, Critical Journeys, and Container Gate.

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
Foundry has no rules for has every placeholder treated as masked. The plugin
and upstream editors mark each masked field that still holds a placeholder,
block Save until it is re-entered or cleared (clearing omits it, which deletes
the stored secret, because `PUT` is a full replace), only point out a
placeholder-shaped value anywhere else, and show Edge's `400` field list when a
save is refused anyway. A non-admin targets save on an upstream whose Consul
token is masked, and a plugin rollback whose earlier read was masked for the
session's role, are refused locally and reported instead of being sent. The Pinned Gateway
Contract checks that an `operator` read-modify-write of a plugin configuration
with a masked endpoint path is refused, that the fields Edge refuses for an
`operator` are exactly the ones Foundry's replay predicts (a placeholder in
`otel_tracing`'s `authorization` is refused, one in its `service_name` is not),
and that an `admin` may write a placeholder. `npm run check:plugin-sensitivity`
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
  `PUT`/`DELETE` of the four resource item paths, and only with a strong tag
  read from the gateway (`src/api/conditionalWrite.ts`). The mock admin gateway
  refuses the same way, and the gateway contract asserts both `400`s.
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
does not read `GET /backend-egress-policy`.

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
(2026-11-02); v0.9.16 and v0.9.18 were tagged but not published. Most of the
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

Source commits, platform digests, release runs and Foundry image digests for
the rows above are preserved in the
[v0.5.5 tagged copy of this page](https://github.com/ferrum-edge/ferrum-foundry/blob/v0.5.5/docs/compatibility.md#history)
and the immutable records.

## Tested support

This is the qualification envelope v0.5.5 passed against Edge v0.9.15, which
the v0.5.6 candidate must pass against Edge v0.9.20. The gates run on every
pull request and again before publication against `edge.image`. The machine-readable `tested` dimensions describe the qualified
envelope; they do not qualify other Edge images or gateway modes.

| Dimension | Qualification target | Evidence gate |
| --- | --- | --- |
| Gateway mode | `database` on SQLite, admin writes enabled, admin JWT with audience and `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` | Pinned Gateway Contract, Deployment Starter, Critical Journeys, Container Gate |
| Read-only admin API | `database` started with `FERRUM_ADMIN_READ_ONLY=true` | Pinned Gateway Contract (capability parity, read-only half) |
| Roles | `viewer`, `operator`, `admin` | capability parity (every surface and the launch reads, per role); critical journeys through the identity proxy |
| Authentication | `trusted-proxy` behind the starter's nginx identity proxy, with the shared group-to-role policy | Deployment Starter, Critical Journeys |
| Deployment path | `deploy/starter` (Compose) with the production Foundry image | Deployment Starter, Critical Journeys |
| Browser | Chromium bundled with `@playwright/test` 1.63.0, Desktop Chrome profile | Critical Journeys |
| Container platforms | `linux/amd64`, `linux/arm64` | Container Gate (both builds start and serve a protected request) |
| BFF Node.js | 22.22.2 and 24.15.0 minimums (the image ships 24) | Quality Gate matrix |

### Tested scale

Scale claims stop at what has been measured.

- **Against the real gateway:** the demo seed and contract fixtures, tens of
  resources per namespace across two namespaces. Nothing larger has been run
  against a real gateway.
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

## Best-effort

Expected to work because nothing Foundry does depends on them, but not run in
CI. Report problems; they do not block releases.

- `database` mode on PostgreSQL or MySQL.
- `cp` (control-plane) mode.
- Other Chromium-based browsers, Firefox, and Safari.
- Kubernetes or any other deployment that reproduces the documented
  trusted-proxy contract ([deployment.md](deployment.md)).
- Static-token authentication (development only).

## Not qualified

- `file`, `dp`, `mesh`, and `node_agent` gateway modes. The UI treats them as
  read-only ([capabilities.md](capabilities.md)) and the mock admin gateway
  reproduces that, but no real gateway in those modes runs in CI. The mesh,
  waypoint, trust, and chargeback pages are therefore unqualified.
- Any Foundry version other than the v0.5.6 candidate against Edge v0.9.20,
  and published v0.5.5 against Edge v0.9.15. Previous successful
  qualification cannot qualify a moved pin.
- Any Ferrum Edge release other than v0.9.20 (`edge.release`) for this
  candidate. Earlier pairings are in [History](#history).
- Any Ferrum Edge image other than `edge.image`, including the `0.9.20-ebpf`
  and `0.9.20-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. Every published release since, v0.9.8
through v0.9.20, retains it. It is not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag.
The v0.9.15 contract gate confirmed the strong item tags for v0.5.5, and the
candidate's contract gate checks them against v0.9.20.
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
   Contract) fails while the table differs from Edge's.
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
