# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer. This
page is the human-readable record. [`compatibility.json`](compatibility.json)
is the machine-readable one, and CI reads the gateway image from it.

**Record version 1, status: released.** Foundry v0.4.0 was recorded from the
release run itself: its source commit, multi-architecture image digest, and CI
run below were filled when the release was cut, never guessed ahead of it. The
Edge pairing and its qualification were recorded in
[#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524).

## The pairing

Foundry v0.4.0 pairs with the published Ferrum Edge v0.9.10 release. The
previous release pairing, Foundry v0.3.0 with Edge v0.9.8, is recorded in
[history](#history).

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | 0.4.0 (previous release: [v0.3.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.3.0)) | [v0.9.10](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.10) |
| Source commit | `cb6dbe5b2b2e3f3ed211d5e829322d867ecb7a36`, the commit the `v0.4.0` tag points to, also the image's `org.opencontainers.image.revision` label | `ee040d5e3281fde424aa65f5b18004852c5b53b0`, the commit the `v0.9.10` tag points to, built by Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36852417185) |
| Image | `ferrumedge/ferrum-foundry@sha256:03d4baa0e424c4438abb65da4ee3a4441f50cde9f2eb4e28664e5cf0698c0241`, the release's multi-architecture index digest | `ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc`, the release's multi-architecture index digest |
| Platforms | `linux/amd64` `sha256:e72ca1c95809b9b06b143c9c6c16b48763c6fc70a39aeb52ecb4b598228e00be`, `linux/arm64` `sha256:f8d5a740906c6c7b40311b0f48f371ab90498c8974ae8ca1e4e333ab61409b14` | `linux/amd64` `sha256:18a8a962ad13bacb2505a122330bb25ce921b21a2f3cb5362a6ea93f11fe44d5`; `linux/arm64` `sha256:c35253bed87153afa6e193074f9b644eb3feeedb35459d1c15de5a23a78e4891` |
| CI evidence | [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153), green including the Pre-publication Gates, for the tagged commit | same run, with `edge.image` at the release; qualified in [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) |

Run Edge by digest, never by tag: `ferrumedge/ferrum-edge:latest` is not
updated for releases, and any tag can be moved. The `0.9.8-ebpf` and
`0.9.8-ebpf-tools` variants were not qualified. The
`0.9.9-ebpf` and `0.9.9-ebpf-tools` variants were not qualified by #512, and
the `0.9.10-ebpf` and `0.9.10-ebpf-tools` variants are not qualified here.

## The CI pin

Every gateway-backed gate runs `edge.image`, the published v0.9.10 release by
its multi-architecture index digest:

| Version | Source commit | Image index | Platform manifests |
| --- | --- | --- | --- |
| [v0.9.10](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.10) | `ee040d5e3281fde424aa65f5b18004852c5b53b0` | `ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc` | `linux/amd64` `sha256:18a8a962ad13bacb2505a122330bb25ce921b21a2f3cb5362a6ea93f11fe44d5`; `linux/arm64` `sha256:c35253bed87153afa6e193074f9b644eb3feeedb35459d1c15de5a23a78e4891` |

Release facts: Edge [release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36852417185).
The prior Foundry v0.3.0 / Edge v0.9.8 pairing and the v0.9.9 qualification
remain in [history](#history).

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; v0.9.8, v0.9.9, and v0.9.10 retain
   it. See [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5, v0.9.7, v0.9.8, v0.9.9, and v0.9.10, has both:
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

`node scripts/supported-pairing.mjs release-ready` enforces the recorded part
of this. The release workflow runs it and refuses a tag while `edge.release`
still holds `RELEASE-STEP` placeholders or `edge.image` is not that release.

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
| [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) onward | v0.9.10, `ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc` (source commit `ee040d5e3281fde424aa65f5b18004852c5b53b0`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36852417185); `linux/amd64` `sha256:18a8a962ad13bacb2505a122330bb25ce921b21a2f3cb5362a6ea93f11fe44d5`, `linux/arm64` `sha256:c35253bed87153afa6e193074f9b644eb3feeedb35459d1c15de5a23a78e4891`) | Qualified in [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524) and recorded as `edge.release` and `edge.image`. It includes ferrum-edge#5954, the fail-closed MCP charset and JSON-RPC batch handling security fixes described above. `PLUGIN_SENSITIVITY_SOURCE` was re-read at `ee040d5e3281fde424aa65f5b18004852c5b53b0`; its source file is unchanged from v0.9.9. Foundry [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0) paired with it: source commit `cb6dbe5b2b2e3f3ed211d5e829322d867ecb7a36`, image `ferrumedge/ferrum-foundry@sha256:03d4baa0e424c4438abb65da4ee3a4441f50cde9f2eb4e28664e5cf0698c0241` (`linux/amd64` `sha256:e72ca1c95809b9b06b143c9c6c16b48763c6fc70a39aeb52ecb4b598228e00be`, `linux/arm64` `sha256:f8d5a740906c6c7b40311b0f48f371ab90498c8974ae8ca1e4e333ab61409b14`), [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153) |

## Tested support

Everything here runs on every pull request, and again before a release is
published (the release workflow calls the CI workflow as its Pre-publication
Gates), against `edge.image`.

| Dimension | Qualified | Evidence |
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
- Any Ferrum Edge release other than v0.9.10 (`edge.release`). The previous
  Foundry v0.3.0 / Edge v0.9.8 pairing remains listed in history.
- Any Ferrum Edge image other than `edge.image`, including the `0.9.10-ebpf`
  and `0.9.10-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. v0.9.8, v0.9.9, and v0.9.10 carry it
unchanged. It is not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag.
Against the v0.9.10 release every item read does, so a full-replacement save
or a detail-page delete is atomic: a writer that commits between the guard's
verification read and the write is refused with `412` and nothing is written.
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
4. Open a pull request. Every gateway-backed gate (contract, capability
   parity, starter, critical journeys, container) runs against the new image.
   A failure is a compatibility finding to review, not a test to relax.

If the candidate fails, restore the previous `edge.image`, record the candidate
in `edge.rejected_images` with its finding and CI run, and add it to
[Evaluated and rejected](#evaluated-and-rejected).
