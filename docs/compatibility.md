# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer.
[`compatibility.json`](compatibility.json) is the machine-readable current
pairing record, and CI reads the gateway image from it.

**Record version 2, status: released; qualification: passed.** Published
Foundry v0.5.5 pairs with published Edge v0.9.15, a security release, and
canonical `contracts-edge-0.9.15`. Its source, image, qualification and
publication evidence are preserved in the immutable
[v0.5.5 record](release-notes/v0.5.5.compatibility.json). Earlier pairings and
their immutable records are in [History](#history).

## The published pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | v0.5.5; previous release v0.5.4 | [Ferrum Edge v0.9.15](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.15) |
| Source commit | `359e1cd4efab110475b294452dfeeaefc7a4d5e6`, tag target; release PR #567 merge, second parent `d1e46e227d2d868ec51a1ca6bd6bfa04b51de8a5` | `25b37395ff61bfea0f3ffd189d9011c4984fa755`, immutable `v0.9.15` tag target |
| Image | `ferrumedge/ferrum-foundry@sha256:5bdfa947adead6895e9dbdc4b4db5ed7e960bd7fc5ebb9872ac722ced86a8b0f` | `ferrumedge/ferrum-edge@sha256:29b468dfeea13b1ecaac8dfbc7e019f310e71e647611d43800a1dc64436eaca3` |
| Platforms | `linux/amd64` `sha256:1c5ead0beb5d7608895c4ca3ebc87b11d449948066efd1397042810fb69f847a`; `linux/arm64` `sha256:52a4617dcb20bb99e0180f6bb4ff8cd451b93b0dee99c01830c71a7519be87dc` | `linux/amd64` `sha256:0404dc6d70d67abb70feea4e5aa295fdb1c19a0968900f467fc4b908528d19d1`; `linux/arm64` `sha256:51b8134770441b3ad340ba87ca9acd8a03fd864315c54d79911b27d95437c91a` |
| Qualification | [Run 37846502086](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37846502086), attempt 1; source `f947a607f0bbb920d508e88568969bbe69e5ed58`, tested merge `8126d6b771f90bd76e8a54b48ddfa26441175c27` | Edge release run 37823250818; distribution evidence only |
| Publication | [Release run 37848400800](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37848400800), success; GitHub release 407290286, published 2026-10-08 21:48:04 UTC | GitHub release 407222520, published 2026-10-08 20:11:03 UTC |

Edge v0.9.15 fixes 26 published Ferrum Edge security advisories (5 high,
19 medium, 2 low). Operators should upgrade Edge; the changes Foundry reacts to
are in [Admin API changes in v0.9.15](#admin-api-changes-in-v0915).

## The CI pin

Every gateway-backed gate reads `edge.image`, the published v0.9.15 default
multi-architecture index above. Edge release `407222520` was published at
2026-10-08 20:11:03 UTC from tag commit
`25b37395ff61bfea0f3ffd189d9011c4984fa755`, the merge of release PR #6103,
after all 15 main-push workflows succeeded on that commit. Release run
`37823250818` completed all 20 jobs successfully, including signing,
attestation and both release gates (Linux GNU ABI and image attestation). The
raw Docker Hub index bytes for both the `0.9.15` and `v0.9.15` tags hash to the
recorded index digest, and the two platform manifests and their configs were
read from the registry by digest. The `ferrum-edge` and `ferrum-cni` layers of
both platform images were downloaded by digest and unpacked: all four binaries
are byte-identical to the corresponding release assets.
`edge.release.binary_sha256` records the seven published binary hashes; all 14
assets and seven named checksum sidecars agree with the GitHub API digests. No
binary or image ran locally for this preparation.

Anonymous GHCR token requests return 401; anonymous GHCR contents are not
claimed. Published Edge configs have no revision label. Source identity rests on
the immutable release and exact binary pairing, with hosted attestation
evidence; no local cryptographic verification is claimed. The published
Foundry index and platform manifests are preserved in its immutable record.
The `0.9.15-ebpf` and `0.9.15-ebpf-tools` variants are published but outside the
v0.5.5 qualification target.

The raw canonical OpenAPI at the immutable Edge source has SHA-256
`f6c7d8b1d247060c4d0ae66e5c149ad3d76721addb8176eff45b6fc3d1b4d6b2`.
Its `info.version: 0.2.0` is schema metadata, not either product's version.

## Qualification evidence

1. **Canonical adoption complete.** Published
   [contracts-edge-0.9.15](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.15)
   names `6fb64c5dc2e014204c17609fc717d976f3b4589e`; release `407246047`
   was published at 20:42:07 UTC on 2026-10-08 after the main
   [Validate contracts run 37841329610](https://github.com/ferrum-edge/ferrum-contracts/actions/runs/37841329610)
   succeeded on that commit. The same 18 scoped files are taken byte-exact from
   the tag, and each Git blob matches. Only the two vocabularies (Edge
   provenance, `edge_release`, the OpenAPI digest, the catalog description and
   a new provenance note listing the v0.9.15 config-schema changes) and the
   complete canonical invalid-expectations file change. That file adds a
   `diagnostic-ref` route-protocol-admission negative and a
   `vocabulary-gateway-headers` availability negative without vendoring those
   schemas. All 82 plugin entries, provisioning values, both vocabulary
   schemas, the manifest schema and all 12 manifest fixtures are unchanged.
   Shared manifest/report status remains EXISTING/implemented at Alloy owner
   `81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e`, whose availability stays
   unreleased. Alloy publication and other consumer qualification are separate.
2. **Guided schema static review complete.** At
   `25b37395ff61bfea0f3ffd189d9011c4984fa755`, four of the five complete
   component blocks are byte-identical to 9bd4d5f9. `RateLimitingConfig` adds
   only `ipv6_prefix`; its digest moves to
   `fc6778eda49ab4999909b430a6c90a8abf38b43f8ddf0bfa1e894c5208033037`, the
   guided editor models the new field, and `PLUGIN_SCHEMA_SPEC.ref` moves to
   25b37395 with it. The drift check compares the pinned hashes at
   `edge.source_commit`, and hosted producer export checks
   them independently. [Plugin schemas](plugin-schemas.md#review-history)
   records the review.
3. **Hosted pairing qualification passed.** Run
   [37846502086](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37846502086),
   attempt 1, binds source `f947a607f0bbb920d508e88568969bbe69e5ed58` to tested
   merge `8126d6b771f90bd76e8a54b48ddfa26441175c27`. Every job passed:
   Qualification Source, Quality Gate on Node 22 and 24, Pinned Gateway
   Contract (including writable and read-only capability parity), Deployment
   Starter, Critical Journeys, and both Container Gates.
4. **Foundry publication verified.** Release PR #567 merged as protected
   commit `359e1cd4efab110475b294452dfeeaefc7a4d5e6`, whose second parent is
   `d1e46e227d2d868ec51a1ca6bd6bfa04b51de8a5`. Release run
   [37848400800](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37848400800)
   succeeded; GitHub release
   [407290286](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.5)
   was published at 2026-10-08 21:48:04 UTC. The tag source, image index,
   platform digests and CI evidence are preserved in the
   [immutable v0.5.5 record](release-notes/v0.5.5.compatibility.json).

The database profiles, Node floors and `viewer` / `operator` / `admin` tiers are
unchanged. Like v0.5.2 through v0.5.4, this release includes the initial
untagged-write refusal of the adopted guarded-write policy #542 (see
[below](#guarded-write-initial-validator-policy-542)). It changes no
account-level registry settings under #547.

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; v0.9.8 through v0.9.15 retain it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5 and v0.9.7 through v0.9.15, has both:
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
which Edge requires from v0.9.19. It is not a requirement of this pairing: the
v0.5.5 / v0.9.15 qualification predates the parameter, and v0.9.15 ignores it.
On this pairing Foundry's own membership preflight is the only association
check, and it cannot close the race between its listing and the write; see
[plugin membership](plugin-membership.md#scope-changes-and-proxy-scoped-plugins).

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

This is the qualification envelope passed by v0.5.5 against Edge v0.9.15.
The gates run on every pull request and again before publication against
`edge.image`. The machine-readable `tested` dimensions describe the qualified
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
- Any Foundry version other than v0.5.5. Previous successful qualification
  cannot qualify a moved pin.
- Any Ferrum Edge release other than v0.9.15 (`edge.release`) for this
  release. Earlier pairings are in [History](#history).
- Any Ferrum Edge image other than `edge.image`, including the `0.9.15-ebpf`
  and `0.9.15-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. v0.9.8 through v0.9.15 retain it. It is
not in v0.9.5.

Released Foundry v0.5.5 sends `If-Match` whenever its verification read carries
a strong tag. The v0.9.15 contract gate confirmed the strong item tags for
v0.5.5.
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
5. Open a pull request. Every gateway-backed gate (contract, capability
   parity, starter, critical journeys, container) runs against the new image.
   A failure is a compatibility finding to review, not a test to relax.

If the candidate fails, restore the previous `edge.image`, record the candidate
in `edge.rejected_images` with its finding and CI run, and add it to
[Evaluated and rejected](#evaluated-and-rejected).
