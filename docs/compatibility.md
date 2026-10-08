# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer.
[`compatibility.json`](compatibility.json) is the machine-readable current
pairing record, and CI reads the gateway image from it.

**Record version 2, status: released; qualification: passed.** Published
Foundry v0.5.4 pairs with published Edge v0.9.14 and canonical
`contracts-edge-0.9.14`, unchanged from v0.5.3. Its source, image, qualification
and publication evidence are preserved in the immutable
[v0.5.4 record](release-notes/v0.5.4.compatibility.json). The prior v0.5.3
pairing remains byte-for-byte in its [immutable record](release-notes/v0.5.3.compatibility.json),
alongside the
[v0.5.2](release-notes/v0.5.2.compatibility.json),
[v0.5.1](release-notes/v0.5.1.compatibility.json),
[v0.5.0](release-notes/v0.5.0.compatibility.json) and
[v0.4.0](release-notes/v0.4.0.compatibility.json) records.

## The published pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | v0.5.4; previous release v0.5.3 | [Ferrum Edge v0.9.14](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14), unchanged from v0.5.3 |
| Source commit | `0a855ddeef1e4a998a60a2e0c61e71510365b70e`, tag target; release PR #563 merge, second parent `08562007f526828a5c12c14ae6ee5858703ded1c` | `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`, immutable `v0.9.14` tag target |
| Image | `ferrumedge/ferrum-foundry@sha256:645061444dc4d824aa256796e3891618e9f8446e7b3eb95c184a3147209975e1` | `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` |
| Platforms | `linux/amd64` `sha256:85f0aa16c6a774661e27cfeabec7d5618af9e05ef8dde9bdccc50bb0142e4c4f`; `linux/arm64` `sha256:c2a63fb183a3546fd29bb4e3cfa6e1235326724cd604bf1d47a564b29e25ce98` | `linux/amd64` `sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2`; `linux/arm64` `sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2` |
| CI evidence | Qualification run [37775840732](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37775840732), attempt 1; release run [37781284653](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37781284653), successful | [Edge release run 37585311307](https://github.com/ferrum-edge/ferrum-edge/actions/runs/37585311307), all 20 jobs successful; distribution evidence only |
| Published | GitHub release [406851205](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.4), 2026-10-08 13:19:12 UTC | GitHub release 405571232, 2026-10-07 08:59:56 UTC |

The release's source changes since v0.5.3 are in the
[v0.5.4 notes](release-notes/v0.5.4.md). They bound what a namespace-scoped
session may reach through the BFF; no Edge admin API contract changes.

## The CI pin

Every gateway-backed gate reads `edge.image`, the published v0.9.14 default
multi-architecture index above. Edge release `405571232` was published at
2026-10-07 08:59:56 UTC from tag commit
`9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`, the merge of release PR #6050,
after all 14 main-push workflows succeeded on that commit. Edge release run
`37585311307` completed all 20 jobs successfully, including signing,
attestation and both release gates. The hosted Foundry qualification run
37758405759, attempt 1, passed against this pairing for the v0.5.3 source. The
publication run 37781284653 succeeded and published the v0.5.4 tag. The
immutable record carries the Foundry tag source, image index, platform digests
and CI evidence. v0.5.4 was qualified against this unchanged pin.

The raw Docker Hub index bytes for both the `0.9.14` and `v0.9.14` tags hash to
the recorded index digest, and the two platform manifests and their configs
were read from the registry by digest. The `ferrum-edge` and `ferrum-cni`
layers of both platform images were downloaded by digest and unpacked: all four
binaries are byte-identical to the corresponding release assets.
`edge.release.binary_sha256` records the seven published binary hashes; all 14
assets and seven named checksum sidecars agree with the GitHub API digests. No
binary or image ran locally for this preparation.

Anonymous GHCR token requests return 401; anonymous GHCR contents are not
claimed. Published Edge configs have no revision label. Source identity rests on
the immutable release and exact binary pairing, with hosted attestation
evidence; no local cryptographic verification is claimed. The `0.9.14-ebpf`
and `0.9.14-ebpf-tools` variants are outside the v0.5.3 and v0.5.4
qualifications.

The raw canonical OpenAPI at the immutable Edge source has SHA-256
`6d286649ae744691e2eeb7d16607c538ca02e31bdeaafe98ab07fc861e7b9da4`.
Its `info.version: 0.2.0` is schema metadata, not either product's version.

## Qualification evidence

1. **Canonical adoption unchanged.** Published
   [contracts-edge-0.9.14](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.14)
   names `ddbdd845733b7046c4393ac951011dafb774db33`; release `406650065` was
   published after the main Validate contracts run `37755967635` succeeded.
   The same 18 scoped files are byte-exact from the tag. The complete invalid
   expectations add the backend-egress-policy v2 data-plane-attestation
   negatives without vendoring those schemas. All 82 plugin entries,
   provisioning values, manifest schema and 12 fixtures are unchanged. The
   shared manifest/report status remains EXISTING/implemented at the Alloy
   owner, whose availability remains unpublished.
2. **Guided schema static review unchanged.** All five complete component
   blocks at `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d` are byte-identical to
   9b83115d, so every pinned hash is unchanged and the drift check compares
   them at `edge.source_commit`. `PLUGIN_SCHEMA_SPEC.ref` remains 9b83115d,
   the source of the last reviewed hosted producer export. The plugin
   sensitivity source is byte-identical to its prior version and its
   provenance is recorded at the v0.9.14 source.
3. **Hosted pairing qualification passed.** Run
   [37775840732](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37775840732),
   attempt 1, binds source
   `9407c05dce79c9752d9ae3621c1f2f3caf467a35` to tested merge
   `c2e2aa642c961fd6bff184f0fb8a90214c746c17`. Every job passed: Qualification
   Source, Quality Gate on Node 22 and 24, Pinned Gateway Contract (including
   writable and read-only capability parity), Deployment Starter, Critical
   Journeys, and both Container Gates.
4. **Foundry publication verified.** Release PR #563 merged as protected
   commit `0a855ddeef1e4a998a60a2e0c61e71510365b70e`, whose second parent is
   `08562007f526828a5c12c14ae6ee5858703ded1c`. Release run
   [37781284653](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37781284653)
   succeeded; GitHub release
   [406851205](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.4)
   was published at 2026-10-08 13:19:12 UTC. The tag source, image index,
   platform digests and CI evidence are preserved in the
   [immutable v0.5.4 record](release-notes/v0.5.4.compatibility.json).

The database profiles, Node floors and `viewer` / `operator` / `admin` tiers are
unchanged. Like v0.5.2 and v0.5.3, this release includes the initial
untagged-write refusal of the adopted guarded-write policy #542 (see
[below](#guarded-write-initial-validator-policy-542)). It changes no
account-level registry settings under #547.

## Previous published pairing: v0.5.3 / Edge v0.9.14

The following evidence qualifies the previous immutable release only. It does
not qualify v0.5.4, although both use the same Edge pin. Its
qualification run, release ancestry and full publication facts remain in the
[v0.5.3 notes](release-notes/v0.5.3.md) and
[immutable record](release-notes/v0.5.3.compatibility.json). The v0.5.2 and
earlier pairings and their publication facts remain in [history](#history) and
their immutable records.

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | [Foundry v0.5.3](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.3); previous release v0.5.2 | [Ferrum Edge v0.9.14](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14) |
| Source commit | `74a7be374f5c6fcf1284737907e43d8808bb95c6`, tag target; release PR #560 merge, second parent `0430caaa8a97f729cffa065d63c5fcaf54c7ff4d` | `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`, immutable `v0.9.14` tag target |
| Image | `ferrumedge/ferrum-foundry@sha256:1edef8251f7786f10ebb67dd333cf9e75f7bf54f7af17ad4452227df3ac9a742` | `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` |
| Platforms | `linux/amd64` `sha256:784c34fb6bc9f945a4fbb0d648e9ea3113cf71396dd14eadba913586dd9f2dd4`; `linux/arm64` `sha256:cfd8e4063fa371395eb577cadbcab75e9c52ab00765cc3d0a739e736908e39dc` | `linux/amd64` `sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2`; `linux/arm64` `sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2` |
| Qualification | [Run 37758405759](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37758405759), attempt 1; source `e88b83416e7ca6f60bdaa79ccd028c29b1cf99ec`, tested merge `885934d6bdb01f89d380d4d1010cc4e7627d20d0` | Edge release run 37585311307; distribution evidence only |
| Publication | [Release run 37760444063](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37760444063), success; GitHub release 406687099, published 2026-10-08 10:07:37 UTC | GitHub release 405571232, published 2026-10-07 08:59:56 UTC |

Anonymous GHCR access, independent cryptographic attestation verification and
account-level registry immutability are not proved. Foundry #547 remains pending.

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; v0.9.8 through v0.9.14 retain it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5 and v0.9.7 through v0.9.14, has both:
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

### Admin API changes in v0.9.8

None that Foundry reflects. Edge's
[upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.8/docs/upgrade_guide.md)
("Upgrading to 0.9.8") covers data-plane behavior: native HTTP/3 enforcing
HTTPRoute rule `timeouts`, the `request_timeout` `X-Gateway-Error` token, the
`ValidateJWTSVID` claims wire type, and SSE, gRPC-Web, and backend TLS fixes.
Between the `v0.9.7` and `v0.9.8` tags, Edge's `src/admin` and `src/config`
trees, `plugin_config_projection.rs`, `plugin_cache.rs`, and
`plugins/access_control.rs` are identical, so the admin routes, role checks,
`ETag`/`If-Match` handling, the `proxy_id` filter, the plugin sensitivity
table, and the scope merge Foundry models are those of v0.9.7. The one
`openapi.yaml` change on a surface Foundry edits is a new optional
`adaptive_concurrency` field, `baseline_window_samples` (default `1000`), which
Foundry's default template omits and its raw editor passes through unchanged.

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
the replay finds. The plugin sensitivity schema rules are
unchanged from v0.9.8, and Foundry records their source commit at v0.9.9.

#### MCP tool catalog, generated tools, and per-group grants

Ferrum Edge v0.9.9 was the first release with everything the proxy page's MCP
Tools tab (#505) needs; none of it is in v0.9.8:

- **The catalog read**, `GET /proxies/{id}/mcp/tools` (ferrum-edge#5949):
  each tool's public name, source, title, description, annotations, policy
  (`action`, `configured`, `effective`, `listed`, `callable`), grants,
  `schema_hash`, and `discovered_at`, plus each instance's `catalog_state`,
  servers, `tools_refresh` outcome, and fixed-text `refresh_error`. Every role
  from `viewer` up gets the same projection; a server's `upstream_url` is
  always reduced to `scheme://host[:port]` plus `/[REDACTED_PATH]`.
- **Generated OpenAPI tools** (`servers.*.openapi`, ferrum-edge#5906): the
  catalog reports them as `source.type: openapi` with the operation's name,
  method, and path. Their `listed` and `callable` flags also account for the
  proxy's `allowed_methods`.
- **Per-group grants** (`policy.tools.*.allowed_groups` / `denied_groups`,
  ferrum-edge#5919), matched against the calling Consumer's `acl_groups`.
  Foundry checks the rules Edge applies at plugin load before it sends a
  save: groups only on `allow`, no empty list, no group in both lists, at most
  255 bytes per group and 512 distinct groups across the map, and a
  group-conditioned name must start with a configured server's namespace and
  the namespace separator.

**The catalog is node-local.** It is what the node behind Foundry's admin API
has cached. Edge never contacts an upstream or starts a refresh for this read,
and an upstream that tailors tools per principal shows one session's view. A
control plane runs no data plane, so it answers every instance
`catalog_state: not_served` with no tools, as does a data plane that does not
serve the proxy's namespace or has not loaded the change yet. Foundry
connects to one admin API (`FERRUM_ADMIN_URL`) and cannot route a read to a
particular data plane, so it does not pretend: on a `cp` gateway the tab says
the catalog lives on each data plane's own admin API and that a Foundry
deployment connected to a data plane serving the namespace shows it. The
stored policy is still listed, from the plugin configuration, and stays
editable on the control plane, which is where configuration is written. A
saved policy is "configured" at once and reaches the catalog only when the
node reloads; until then the row says it is not yet live on this node.

**Writing a policy** is a plugin configuration write, not a catalog write: it
needs `operator` or above on a writable gateway, replaces one
`config.policy.tools` entry through the conditional-write path, omits
`labels` (so `provisioned-by` survives), and is refused before sending when
the session's read masks a value. In practice an `operator` read masks the
path of every MCP server URL that has one, so such configurations need an
`admin`, or the masked values re-entered on the plugin page first.

The capability parity contract probes the catalog read as each role (see
[capabilities.md](capabilities.md)); `scripts/mock-admin-gateway.mjs` serves it
with the same shape and node-local states, and
`scripts/mock-admin-gateway.mcp.test.mjs` runs a policy edit end to end
against it.

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
  `400`. Other new refusals (non-finite `FERRUM_*` floats,
  `FERRUM_MAX_CREDENTIALS_PER_TYPE=0`, mesh listener ports, Redis URL database
  selectors, `ECHCONFIG` blocks in `mtls_auth` CA bundles) concern gateway
  settings or plugin configuration that Foundry passes through unchanged; the
  gateway's `400` is shown as returned.
- **Diagnostic wording.** Plugin configuration errors now quote field names
  and values with backticks and double quotes instead of single quotes. The
  gateway contract compares each default-template rejection as an exact string
  recorded from the pinned gateway ([plugin-defaults.md](plugin-defaults.md)).

### MCP security fixes in v0.9.10

Ferrum Edge v0.9.10 contains ferrum-edge#5954, addressing GHSA-4f9m-cfqg-fhx9
and GHSA-f2jp-59r9-fp64. The `mcp_gateway` and `ai_prompt_shield` plugins refuse
requests that declare a non-UTF-8 charset and fail closed when JSON-RPC batches
cannot be inspected because they are malformed or nested beyond the supported
depth. These changes do not alter Foundry's gateway API contracts or
`PLUGIN_SENSITIVITY`; the latter was checked against the v0.9.10 source commit.

### Admin API and plugin schema changes in v0.9.11

The released source adds admin-only credential-complete
`GET /consumers/{id}/verification`, coherent conditional namespace backups,
namespace `If-Match` on restore, and process-scoped backend egress metadata.
Foundry refuses browser proxy access to verification before signing or fetching
and keeps ordinary unredacted backup exports in a temporary download operation.
It does not adopt conditional restores or backend egress policy decisions in
this release preparation. Those new contracts are now canonically published;
vendoring Foundry's existing contract scope does not adopt these admin surfaces.

Relative to Foundry's older reviewed schema ref, `RateLimitingConfig` has gained
the optional `mcp_tool_calls` object for counting MCP `tools/call` members.
That object was already present in Edge v0.9.10; it is not a new v0.9.11 UI
feature. The reviewed schema ref and changed digest now come from the actual
hosted producer export described above, with explicit preservation regressions.
This schema adoption does not establish gateway admission or live acceptance.
For the v0.5.0 release, the plugin sensitivity source was byte-identical to
v0.9.10 and its recorded provenance was
`c764084b3b51c3f7ffde268c039688d35e49c553`; the v0.5.1 refresh is below.

Edge v0.9.11 retains the v0.9.10 MCP charset and batch fixes above. It does not
fix [Edge #6008](https://github.com/ferrum-edge/ferrum-edge/issues/6008)
(SOAP pre-auth body collection total deadlines) or
[Edge #6009](https://github.com/ferrum-edge/ferrum-edge/issues/6009)
(native HTTP/3 early-body retained-request admission). This release makes no
claim that all upstream security work is fixed.

### Admin API changes in v0.9.12

Published Edge v0.9.12 adds admin-only `GET /deployment-snapshot`, with
complete original secret-bearing evidence and a distinct strong quoted
`deployment-v1` token. Its opt-in partial proxy delete and API-spec replacement
compare that original authority inside transaction fences and return explicit
`durable`, `live` and `recovery_cleanup_authorized` acknowledgements. The
[owner contract](https://github.com/ferrum-edge/ferrum-edge/blob/0d917701b63ef38210c49df830f48cf0457cbc7d/docs/deployment_mutations.md)
requires retaining original encrypted evidence on refusal or uncertainty;
publication of that contract does not authorize consumer adoption.

Foundry v0.5.1 updates source and distribution pins and explicitly refuses the
new secret-complete deployment snapshot at the browser-facing BFF boundary.
Every method and role receives `403 FERRUM_BFF_CREDENTIAL_READ_DENIED` after
authentication and before capacity admission, JWT signing or upstream fetch.
The denial uses the normalized root pathname, including encoded components,
an optional trailing slash and queries; ambiguous paths retain the existing
`400` refusal. Consumer verification remains blocked, while ordinary masked
reads and ephemeral backup downloads retain their existing behavior.

Foundry adds no native deployment workflow, recovery journal, conditional
restore or capability and changes no ordinary mutation semantics. The initial
untagged-write fallback and post-412 refusal remained unchanged. At v0.5.1
publication, the Foundry #542/#544 and #547 owner decisions were pending. No
deployment-profile browser retention or cleanup guarantee was claimed.

The sensitivity source file is byte-identical to c764 (Git blob
`827bf3a7c998c7ea9c995093ab38320facbd072a`, raw SHA-256
`47136b600b12ab4c11db7d366e2c70e82a5079dbc61f2a625d071171a74c64e5`).
Every table rule and Kafka safe property was read against Foundry's copy before
refreshing `PLUGIN_SENSITIVITY_SOURCE` to the published 0d917701 source.
The five guided schemas were reviewed from the verified v0.9.12 hosted producer
export recorded in [plugin schemas](plugin-schemas.md#v051-hosted-schema-adoption).
Their reviewed ref moved to 0d917701; all five component hashes were unchanged.
No guided field, template, catalog or unmodelled-value behavior changed. Static
review and hosted pairing acceptance are separate; the successful v0.5.1
qualification is preserved in its immutable record.

Edge #6011 is not in the published source. No advisory closure or approval of
unmerged Edge #6002/#6003/#5989, unresolved-route behavior or physical Node
floors follows from this pin move.

### Admin API changes in v0.9.13

Published Edge v0.9.13 bounds namespace and deployment snapshot authority
(ferrum-edge#5999/#6012). Conditional backup tags and `deployment-v1` tokens now
fence stored API-spec documents, external-reference snapshots and other binary
values by SHA-256 and length under new MAC domains, so every tag issued by
v0.9.12 or earlier fails closed with `412`. `GET /deployment-snapshot` carries
those digests in its evidence and sorted `api_specs`, and adds the required
`api_spec_contents` array with one base64 copy of every stored spec document
and external-reference snapshot. The response therefore remains secret-complete.
Foundry's path-based browser refusal is unchanged: every method and role still
receives `403 FERRUM_BFF_CREDENTIAL_READ_DENIED` before capacity admission, JWT
signing or upstream fetch.

A namespace whose canonical representation exceeds 64 MiB (spec bytes
excluded), or a deployment snapshot whose base64 spec content exceeds 256 MiB,
is refused with a deterministic `507 Insufficient Storage`
(`NamespaceSnapshotTooLarge`) on the conditional paths: `GET
/backup?conditional=true`, a tagged `POST /restore`, the conditional proxy
delete and API-spec replacement, and the snapshot read. Nothing is issued,
compared or applied. Foundry issues none of these conditional requests: backup
export is unconditional, restore sends no `If-Match`, and the deployment
mutations need a token only the refused snapshot provides. A raw request that
reaches one through the BFF gets the gateway's `507` status and body unchanged,
and its long-read or upload permit is released; `server/proxy-confinement.test.ts`
covers all four routes beyond both pool sizes.

`GET /backend-egress-policy` moves to `schema_version: 2`, where
`public_only_guaranteed` requires `enforcement_scope=local-data-plane`. Foundry
does not read that endpoint. Native HTTP/3 buffered uploads now take
retained-request admission (ferrum-edge#6009), and route total deadlines bound
body collection before `before_proxy` (partially addressing ferrum-edge#6008);
both are data-plane behavior with no admin contract change for Foundry. The
gRPC affinity, development Compose fixture, ARM64 Cross input,
`hickory-resolver` and CI-hardening changes are likewise outside Foundry's
admin surface.

The plugin registry gains no plugin: `early_route_total` is a hidden support
module, and the canonical plugin catalog entries are unchanged. The sensitivity
source file is byte-identical to 0d917701 (Git blob
`827bf3a7c998c7ea9c995093ab38320facbd072a`, raw SHA-256
`47136b600b12ab4c11db7d366e2c70e82a5079dbc61f2a625d071171a74c64e5`), so the
table was unchanged and `PLUGIN_SENSITIVITY_SOURCE` moved to 9b83115d. All five
guided schema blocks were byte-identical to 0d917701, and `PLUGIN_SCHEMA_SPEC.ref`
moved to 9b83115d from the reviewed hosted export (see
[plugin schemas](plugin-schemas.md#v052-schema-review)). No guided field,
template, catalog or unmodelled-value behavior changed, and no advisory closure
followed from that pin move.

### Admin API changes in v0.9.14

Published Edge v0.9.14 adds control-plane attestation of data-plane backend
egress policy (ferrum-edge#6020, completing #5994). Data planes report their
loaded policy's mode and override presence flags, never CIDRs, addresses or
counts, on ConfigSync `Subscribe`; the ConfigSync protocol revision moves to
`3`, so CP and DP must run the same build. On a control plane
(`enforcement_scope=admission-only`), `GET /backend-egress-policy` gains an
optional `data_plane_attestation` object, additive within `schema_version: 2`
and absent on every other response. Foundry does not read that endpoint.

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

Conditional deployment mutations now report a store failure before the
mutation transaction as `durable: "not_started"` and one inside the rolled-back
transaction as `durable: "not_committed"`; only a failed commit acknowledgement
or lost settlement still reports `"unknown"` (ferrum-edge#6021). The `durable`
enum is unchanged. Foundry issues no deployment mutation and still refuses
`GET /deployment-snapshot` at the BFF for every method and role. The owner
documentation now states that a `deployment-v1` token fences the whole
namespace and gives the snapshot's peak server memory; neither changes a
Foundry path.

Backend HTTP/2 resets with a reason other than `NO_ERROR`, before headers,
during a buffered read or while a body streams, now count as backend failures
(`protocol_error`), and buffered-read errors report their real class
(ferrum-edge#6019/#6022). Built-in plugin trust and security-composition
ordering now key on the registered concrete type, HTTP/3 drain refusals run
the reject hooks and transaction log, and OIDC session-secret screening
refuses two more published fixture keys (ferrum-edge#6022/#6037). These are
data-plane and plugin-admission behaviors with no admin contract change for
Foundry. The gateway contract still submits a freshly generated 32-byte OIDC
session secret, and the OIDC form's local placeholder and length pre-check is
unchanged; Edge's refusal of a published fixture key is shown as returned.

The plugin registry and `PluginConfigBase` are unchanged, so the canonical
catalog keeps its 82 plugins. The sensitivity source file is byte-identical to
9b83115d (Git blob `827bf3a7c998c7ea9c995093ab38320facbd072a`, raw SHA-256
`47136b600b12ab4c11db7d366e2c70e82a5079dbc61f2a625d071171a74c64e5`), so the
table is unchanged and `PLUGIN_SENSITIVITY_SOURCE` now names 9bd4d5f9. All five
guided schema blocks are byte-identical to 9b83115d; see
[Qualification evidence](#qualification-evidence). No guided field, template,
catalog or unmodelled-value behavior changes, and no advisory closure follows
from this pin move.

## Evaluated and rejected

No Edge image is currently rejected (`edge.rejected_images` is empty). A
rejected digest may appear only in history files (`CHANGELOG.md`, this page,
`compatibility.json`, published release notes);
`scripts/supported-pairing.test.mjs` fails if any other file names it.

## History

| Period | `edge.image` | What happened |
| --- | --- | --- |
| Until #409 | `ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d` — development build `main-b96cfaadd41a676d39a409d47b48e0b0588fa86e` (2026-08-27) from Ferrum Edge `main`, never a published release (source commit recorded by Edge's [Docker Manifest job](https://github.com/ferrum-edge/ferrum-edge/actions/runs/33094251786/job/98636370391); `linux/amd64` `sha256:8dc20df77ddf636052bf3191d1584e50ef082db8a5736f495fca9fa078d69c29`, `linux/arm64` `sha256:15bce0a914efca89dbce076dd1617f4a9571717e3fb8493bc38dd56b4d73df20`) | The interim pin. It predates ferrum-edge#4611 and `5db1d77a8`, and the walkthrough and namespace-isolation journey asserted its behavior: a proxy-scoped plugin configuration did not protect the route until the proxy was updated by hand, and a second namespace could not reuse an id (`409`) |
| #385 evaluation | v0.9.5, `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` | Recorded as rejected. Deployment Starter failed the first-success walkthrough because a proxy-scoped `key_auth` config took effect before the walkthrough attached it (`401`, expected `200`; ferrum-edge#4611). Critical Journeys failed "a resource id cannot be reused in another namespace" (`201`, expected `409`; ferrum-edge `5db1d77a8`). Quality Gate, Pinned Gateway Contract (including capability parity), and Container Gate passed ([CI run 35901872338](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/35901872338)). Both failures were Foundry assertions encoding pre-0.9 behavior, not Edge defects |
| #409 until the v0.9.7 pin | v0.9.5, the same digest (source commit `20e76030a05dc49c3804e969516c94ab101110b9`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/34795503690); `linux/amd64` `sha256:3bb2b253e0cc338108320a39de86da216c6e644aef39fd83a3e22ca0ad6173a8`, `linux/arm64` `sha256:d28b77e39e17e2480b3a3f39d55236f8fddbcc8cdf3dbbf314dbba6aa4ad3a1d`) | Foundry's walkthrough, namespace-isolation journey, and documentation were aligned with the Edge 0.9.x semantics, and v0.9.5 moved from `edge.rejected_images` to `edge.image`. It lacked ferrum-edge#5661, so it was the CI pin, never a supported pairing: the write guard verified before each write and sent it unconditionally |
| [#439](https://github.com/ferrum-edge/ferrum-foundry/pull/439) until the v0.9.8 pin | v0.9.7, `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a` (source commit `8fed1346ce2e267eb69c03683cb89ea44d785e0b`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36110533284); `linux/amd64` `sha256:e4d4367e815e86f510c28d8f831ca3502b7c9d5f21fd0eeabeb609a8c8e6f47f`, `linux/arm64` `sha256:7d3d28d2529dfb6a303b734fad0bf35ebec07caa95f5632e81d92170baf15fab`) | The first published Edge release after v0.9.5 (v0.9.6 was tagged but never published) and the first with ferrum-edge#5661. Recorded as `edge.release` and moved to `edge.image` in #439, whose gates are the qualification. The gateway contract requires the `ETag`s, the `412`s, and the strict-`If-Match` `400`s, and the proxy Plugins tab reads `GET /plugins/config?proxy_id=` (ferrum-edge#5726). Foundry [v0.2.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.2.0) paired with it: source commit `c028c235fd83bb7a1962f3e06b0280d8d8ed8878`, image `ferrumedge/ferrum-foundry@sha256:54e784c9a7f658e7f7d2d3bcab32d5ca0b113a417726ad1736c1765e0834fe7f` (`linux/amd64` `sha256:d42862dce8b8fea01bc1d25ff20fc68d26f89789c163415bf0476feb618c14fc`, `linux/arm64` `sha256:295c4b2fa641ad65f4832022fda70a893737b81b7fb4ffbdd20e0d2a02a1f3f2`), [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36125598365) |
| [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498) until #512 | v0.9.8, `ferrumedge/ferrum-edge@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385` | The next published Edge release. Its admin API source, plugin configuration projection, and plugin scope merge are unchanged from v0.9.7 ([Admin API changes in v0.9.8](#admin-api-changes-in-v098)). Recorded as `edge.release` and moved to `edge.image` together with the Foundry v0.3.0 release preparation in [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498), whose gates are the qualification. `PLUGIN_SENSITIVITY_SOURCE` was re-read at `e27f2109216352c3fe9e67a7014611f3f66daa91`. Foundry [v0.3.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.3.0) paired with it: source commit `b0762e61f7138de0fcabc6173308f2c6c78076e1`, image `ferrumedge/ferrum-foundry@sha256:0f8064151f264d8afafef3f581bb44c56af3c88398db21df3b65457e195ab7d6` (`linux/amd64` `sha256:322b8ffc024d964b56b5172683b08c5f8f9abd3a61ef8718e07fbdf99099a5f3`, `linux/arm64` `sha256:7f77563d8121afa84c1f379b69ccd0d25f294dbaaa18051651ae6a9988c5dc09`), [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36325287150) |
| [#512](https://github.com/ferrum-edge/ferrum-foundry/pull/512) until #524 | v0.9.9, `ferrumedge/ferrum-edge@sha256:83bb4de2ea264d5bed18d8f01f94e0e17a29b43aa1458b8984a0e9e1e784ede6` (source commit `234717ce41965cd1e2b5c6c761a25475c5d7628c`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36806975161); `linux/amd64` `sha256:558fba9a1a9d7826e5ff9d84a1c80f24903c202a3a755072f45af0372ce1b477`, `linux/arm64` `sha256:33a8acceab1bee27e999b235cb24311619e44209b865cd68971cd9f3928a8379`) | The v0.9.9 qualification was the most recently supported release before #524. It added the viewer-readable MCP tool catalog read, `allow_path_parameters` on proxies, and the masked-placeholder write refusal (ferrum-edge#5925), which Foundry handles ([Admin API changes in v0.9.9](#admin-api-changes-in-v099)). `PLUGIN_SENSITIVITY_SOURCE` was read at `234717ce41965cd1e2b5c6c761a25475c5d7628c`. Foundry v0.3.0 remains paired with v0.9.8 |
| [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) through the v0.4.0 release | v0.9.10, `ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc` (source commit `ee040d5e3281fde424aa65f5b18004852c5b53b0`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36852417185); `linux/amd64` `sha256:18a8a962ad13bacb2505a122330bb25ce921b21a2f3cb5362a6ea93f11fe44d5`, `linux/arm64` `sha256:c35253bed87153afa6e193074f9b644eb3feeedb35459d1c15de5a23a78e4891`) | Qualified in [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) and recorded as `edge.release` and `edge.image`. It includes ferrum-edge#5954, the fail-closed MCP charset and JSON-RPC batch handling security fixes described above. `PLUGIN_SENSITIVITY_SOURCE` was re-read at `ee040d5e3281fde424aa65f5b18004852c5b53b0`; its source file is unchanged from v0.9.9. Foundry [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0) paired with it: source commit `cb6dbe5b2b2e3f3ed211d5e829322d867ecb7a36`, image `ferrumedge/ferrum-foundry@sha256:03d4baa0e424c4438abb65da4ee3a4441f50cde9f2eb4e28664e5cf0698c0241` (`linux/amd64` `sha256:e72ca1c95809b9b06b143c9c6c16b48763c6fc70a39aeb52ecb4b598228e00be`, `linux/arm64` `sha256:f8d5a740906c6c7b40311b0f48f371ab90498c8974ae8ca1e4e333ab61409b14`), [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153) |
| [Foundry v0.5.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.0) | v0.9.11, the c764 distribution recorded in [the immutable record](release-notes/v0.5.0.compatibility.json) | Qualified and released; source `7ab9ddb732ebd890fb02928d6e4b22470ceab3f7`, image `ferrumedge/ferrum-foundry@sha256:079db008f6e45e721c2b6636be94980c67b69faff963eace2de7be2232a7eb9b`; all release facts remain in that record |
| [Foundry v0.5.1](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.1) | Published v0.9.12, `ferrumedge/ferrum-edge@sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4` | Qualified and released from `1dc43bd1bbd4c2c89ca14e2a603aa478ab1a0d18`; original qualification and actual image/publication evidence are preserved in [the immutable record](release-notes/v0.5.1.compatibility.json) |
| [Foundry v0.5.2](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.2) | Published v0.9.13, `ferrumedge/ferrum-edge@sha256:6caa0987adb4c0a3a368fcd800bb0459cff3d3e219522e2e9c56280205862e50` | Qualified and published; full evidence in the [immutable v0.5.2 record](release-notes/v0.5.2.compatibility.json) |
| [Foundry v0.5.3](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.3) | Published v0.9.14, `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` | Qualified and published; full evidence in the [immutable v0.5.3 record](release-notes/v0.5.3.compatibility.json) |
| [Foundry v0.5.4](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.4) | Published v0.9.14, the same `ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` | Qualified and published; full evidence in the [immutable v0.5.4 record](release-notes/v0.5.4.compatibility.json) |

## Tested support

This is the qualification envelope passed by v0.5.4 against Edge v0.9.14.
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
- Any Foundry version other than v0.5.4. The v0.5.3 qualification of the
  same pin tested other source and cannot qualify this release.
- Any Ferrum Edge release other than v0.9.14 (`edge.release`) for the v0.5.4
  pairing. Published v0.5.3 / v0.9.14, v0.5.2 / v0.9.13, v0.5.1 / v0.9.12,
  v0.5.0 / v0.9.11 and v0.4.0 / v0.9.10 remain in history.
- Any Ferrum Edge image other than `edge.image`, including the `0.9.14-ebpf`
  and `0.9.14-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. v0.9.8 through v0.9.14 retain it. It is
not in v0.9.5.

Released Foundry v0.5.4 sends `If-Match` whenever its verification read carries
a strong tag. The v0.9.14 contract gate confirmed the strong item tags for
v0.5.4. With a strong
tag, a full-replacement save or a detail-page delete is atomic: a writer that
commits between the guard's verification read and the write is refused
with `412` and nothing is written.

In v0.5.1, a read with no strong tag (the cached-config fallback,
`X-Data-Source: cached`) still gets an unconditional write, which narrows the
race to one round trip rather than closing it. v0.5.2 adopts policy #542
below, which refuses that initial untagged read for guarded writes. The contract
`scripts/concurrent-edit-contract.mjs` requires the pinned gateway to issue the
tags, refuse a stale and an invented tag with `412`, and refuse a malformed
`If-Match` and one on a create with `400`. See
[concurrent-edits.md](concurrent-edits.md).

### Guarded-write initial-validator policy (#542)

This policy narrows the supported profile for `guardedReplace` and
`guardedRemove`: the initial fresh verification read must return one nonempty
quoted visible-ASCII strong validator. Without one, guarded proxy settings and
detail deletes, upstream settings/targets and detail deletes, consumer
Details/ACL and detail deletes, and MCP tool policy edits send no `PUT` or
`DELETE`. Drafts and baselines stay mounted; the refusal reports that atomic
verification is unavailable, not that content changed.

The compatibility consequence is deliberate: these guarded operations lose
the released initial unconditional fallback on older gateways, modes without
a database, and cached reads (`X-Data-Source: cached`), including cached reads
from the paired release. Explicit `null`-guard calls, low-level writes, plugin
membership plans, and unrelated operations retain their supported semantics;
the shared validator parser stops accepting empty or malformed tags. Valid
opaque strong tokens require no MAC-format assumption. Namespace, resource,
and gateway-target fences, whole-body preservation, tagged stale-content
comparisons, and bounded `412` re-verification remain in place; the existing
post-412 untagged refusal is unchanged.

**Adopted for v0.5.2.** The owner's delegate approved this behavior change on
2026-10-06, closing #542; #544 implements it. v0.5.2 is the first release that
ships it, and v0.5.3 and v0.5.4 retain it unchanged. See
[the precise scope](concurrent-edits.md#without-a-tag).

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
