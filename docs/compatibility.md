# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer.
[`compatibility.json`](compatibility.json) is the machine-readable current
candidate record, and CI reads the gateway image from it.

**Record version 2, status: candidate; qualification: pending.** Foundry
v0.5.1 selects published Edge v0.9.12. Foundry source, image and publication
CI fields are null; all four qualification identity fields are null. This
source preparation is not a release or successful qualification. The latest
published pairing remains Foundry v0.5.0 / Edge v0.9.11, preserved byte-for-byte
in [its immutable record](release-notes/v0.5.0.compatibility.json), alongside
[the v0.4.0 record](release-notes/v0.4.0.compatibility.json).

## The candidate pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | v0.5.1 candidate; previous release v0.5.0 | [Ferrum Edge v0.9.12](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.12) |
| Source commit | *release step*: null until publication | `0d917701b63ef38210c49df830f48cf0457cbc7d`, immutable `v0.9.12` tag target |
| Image | *release step*: null until publication | `ferrumedge/ferrum-edge@sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4` |
| Platforms | `linux/amd64`, `linux/arm64` qualification pending | `linux/amd64` `sha256:96fda718b2d078090b16ebe06d02bec0b942ca5b8632bb78f5076221db3b6cb6`; `linux/arm64` `sha256:0d3bbf1fb471347711a188b50fdcfe0df444fc7be32256cb9ec6807f338742af` |
| CI evidence | Qualification pending; publication *release step* | [Edge release run 37298358313](https://github.com/ferrum-edge/ferrum-edge/actions/runs/37298358313), all 20 jobs successful; distribution evidence only |

## The CI pin

Every gateway-backed gate reads `edge.image`, the published v0.9.12 default
multi-architecture index above. Root verified raw Docker Hub index, platform
manifest and config bytes, all 14 release assets and seven named checksum
sidecars. Default gateway and CNI binary bytes match the release assets on both
architectures; `edge.release.binary_sha256` records those seven hashes.
The release run passed both Linux GNU ABI checks and hosted authenticated
Docker Hub/GHCR signing, provenance and SBOM verification. No binary or image
ran locally for this preparation.

Anonymous GHCR reads return 401; anonymous GHCR contents are not claimed.
Published Edge configs have no revision label. Source identity rests on the
immutable release and exact binary pairing, with hosted attestation evidence;
no local cryptographic verification is claimed. Foundry post-publication image
identity and revision-label verification remain separate release work.
The `0.9.12-ebpf` and `0.9.12-ebpf-tools` variants are published but outside the
candidate qualification target.

The raw canonical OpenAPI at the immutable Edge source has SHA-256
`f7242228d73d34ad2d7da3c989ec6ba15bb6ae1f2f4c94a8e0a181b000caae77`.
Its `info.version: 0.2.0` is schema metadata, not either product's version.

## Qualification evidence

1. **Canonical adoption complete.** Published
   [contracts-edge-0.9.12](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.12)
   names `31f0a21d707795be293d15837c2f77c3d84219d8`; release `403772929`
   was published at 13:58:38 UTC on 2026-10-05 after the sole main
   [Validate contracts run 37320780987](https://github.com/ferrum-edge/ferrum-contracts/actions/runs/37320780987)
   succeeded. No tag Release workflow exists in that repository.
   The same 18 scoped files are downloaded byte-exact, including immutable
   descriptions and the complete canonical invalid-expectations file. That file
   adds deployment negatives without vendoring the new deployment schemas.
   The manifest schema and all 12 manifest fixtures are unchanged. Shared
   manifest/report status remains EXISTING/implemented at Alloy owner
   `81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e`, whose availability stays
   unreleased. Alloy publication and other consumer qualification are separate.
2. **Guided schema review pending.** The five source components were read at
   0d917701; refs and hashes retain the actual reviewed c764 export from run
   `37239682559`, attempt 1, artifact `11316747307`. That failed producer is
   historical schema evidence, never pairing acceptance. The controller must
   retrieve and review the new hosted producer's exact blocks, source identity,
   archive digest and exported checksum before changing schema provenance.
   [Plugin schemas](plugin-schemas.md#v051-candidate-review-pending) records
   the pending work and existing preservation behavior.
3. **Hosted pairing acceptance pending.** After the controller creates the
   candidate draft PR, Qualification Source, Quality Gate on Node 22 and 24,
   Pinned Gateway Contract (including writable/read-only capability parity),
   Deployment Starter, Critical Journeys and both Container Gates must pass
   for the exact candidate head and its tested merge. No prior run qualifies
   this tree. Every later source or documentation edit requires fresh gates;
   only an evidence-only qualification record may follow the qualified tree.
4. **Foundry publication pending.** No v0.5.1 tag, published source commit,
   image, platform digest or release CI evidence is asserted. Root owns the
   separate protected merge and release sequence after full qualification.

The database profiles, Node floors and `viewer` / `operator` / `admin` tiers
are unchanged. This candidate includes no initial untagged-write refusal from
Foundry PR #544 and changes no account-level registry settings under #547.
Those owner decisions remain pending.

## Previous published pairing: v0.5.0 / Edge v0.9.11

The following evidence qualifies the previous immutable release only. It does
not qualify the v0.5.1 candidate or the moved Edge pin. Its successful main
push, qualification source/tested merge, release ancestry and full publication
facts remain in the [v0.5.0 notes](release-notes/v0.5.0.md) and immutable record.

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | [Foundry v0.5.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.5.0) (previous release: [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0)) | [v0.9.11](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.11) |
| Source commit | `7ab9ddb732ebd890fb02928d6e4b22470ceab3f7` | `c764084b3b51c3f7ffde268c039688d35e49c553`, the commit the `v0.9.11` tag names |
| Image | `ferrumedge/ferrum-foundry@sha256:079db008f6e45e721c2b6636be94980c67b69faff963eace2de7be2232a7eb9b` | `ferrumedge/ferrum-edge@sha256:2476b502855940e28157858fc24008545cb3baeb3084c9610e1d4505cbe0d36e` |
| Platforms | `linux/amd64` manifest `sha256:6c8afe8408e81cb8d6eab199ed660a48a64ba3fa1f717afb350c65308c41581d`; `linux/arm64` manifest `sha256:b0e0164048418b5c3d6eb0b1ffa81a7bf841bf780c087a498979a5a1abd0b93b` | `linux/amd64` `sha256:7287d297e8f305c99143e148f910024e50fac0341e7fd89236325331fe405b22`; `linux/arm64` `sha256:738a68e81da5cc9c0dde8e8ed5ba9e9c6957fcbdd930070d60d8782c303bb9eb` |
| CI evidence | [Foundry release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37244220739), attempt 1; [qualification run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37242547170), attempt 1 | Edge [release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/37229572280), all 20 jobs successful; this is distribution evidence, not Foundry qualification |

Foundry's `v0.5.0` GitHub release was published at 2026-10-04 23:42:32 UTC
with no downloadable assets; container images are the release artifacts. Root
verified the Docker Hub index and both platform manifest/config byte digests,
and confirmed both platform revision labels name the Foundry source commit.
The `linux/amd64` manifest is
`sha256:6c8afe8408e81cb8d6eab199ed660a48a64ba3fa1f717afb350c65308c41581d`
with config `sha256:b3326e1552b881cdcbc2038b9d60c4d3ed0bdde8d99a10a87c6fb9015c7e3c24`;
the `linux/arm64` manifest is
`sha256:b0e0164048418b5c3d6eb0b1ffa81a7bf841bf780c087a498979a5a1abd0b93b`
with config `sha256:2d7f031670bbe7804891729296a5e9af2bf348fd210f4799a284873e1ea08967`.
Both Docker Hub version tags resolve to the same index. GHCR's hosted
publication jobs succeeded for both tags and the same index, but anonymous
registry reads returned HTTP 401, so anonymous GHCR contents are not claimed
as independently verified. This record does not claim signature verification.

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; v0.9.8 through v0.9.12 retain it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5 and v0.9.7 through v0.9.12, has both:
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
`c764084b3b51c3f7ffde268c039688d35e49c553`; the candidate refresh is below.

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

This candidate updates source and distribution pins only. Foundry adds no
native deployment workflow, recovery journal, conditional restore or capability
and changes no ordinary mutation semantics. Consumer verification remains
blocked, ordinary backup exports remain ephemeral downloads, and the initial
untagged-write fallback and post-412 refusal remain unchanged. Foundry #542/#544
and #547 owner decisions are still pending. The generic authenticated BFF
forwarder has no deployment-snapshot-specific denial; deciding whether to block
that new secret-complete read before any UI adoption is separate root work.
No deployment-profile browser retention or cleanup guarantee is claimed here.

The sensitivity source file is byte-identical to c764 (Git blob
`827bf3a7c998c7ea9c995093ab38320facbd072a`, raw SHA-256
`47136b600b12ab4c11db7d366e2c70e82a5079dbc61f2a625d071171a74c64e5`).
Every table rule and Kafka safe property was read against Foundry's copy before
refreshing `PLUGIN_SENSITIVITY_SOURCE` to the published 0d917701 source.
The five guided schemas were read there too; their refs/hashes stay at the
reviewed c764 hosted export until fresh hosted producer review. No guided
field, template, catalog or unmodelled-value behavior changes.

Edge #6011 is not in the published source. No advisory closure or approval of
unmerged Edge #6002/#6003/#5989, unresolved-route behavior or physical Node
floors follows from this pin move.

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
| Foundry v0.5.1 candidate | Published v0.9.12, `ferrumedge/ferrum-edge@sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4` | Verified upstream distribution and canonical adoption; Foundry qualification and publication pending |

## Tested support

This is the unchanged qualification target. Acceptance against v0.9.12 is
pending. Earlier v0.9.11 evidence qualifies only the published v0.5.0 source.
The gates run on every pull request and again before publication against
`edge.image`. The machine-readable `tested` dimensions describe the envelope
required for qualification; they do not assert that this candidate has passed.

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
- The v0.5.1 / v0.9.12 candidate itself, until all hosted gates pass. Previous
  successful qualification cannot qualify a moved pin.
- Any Ferrum Edge release other than v0.9.12 (`edge.release`) for this
  candidate. Published v0.5.0 / v0.9.11 and v0.4.0 / v0.9.10 remain in history.
- Any Ferrum Edge image other than `edge.image`, including the `0.9.12-ebpf`
  and `0.9.12-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. v0.9.8 through v0.9.12 retain it. It is
not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag.
The v0.9.12 contract gate must confirm the strong item tags. With a strong
tag, a full-replacement save or a detail-page delete is atomic: a writer that
commits between the guard's verification read and the write is refused with
`412` and nothing is written.
A read with no strong tag (the cached-config fallback, `X-Data-Source: cached`)
still gets an unconditional write, which narrows the race to one round trip
rather than closing it. `scripts/concurrent-edit-contract.mjs` requires the
pinned gateway to issue the tags, refuse a stale and an invented tag with
`412`, and refuse a malformed `If-Match` and one on a create with `400`. See
[concurrent-edits.md](concurrent-edits.md).

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
