# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer. This
page is the human-readable record. [`compatibility.json`](compatibility.json)
is the machine-readable one, and CI reads the gateway image from it.

**Record version 1, status: candidate.** The Foundry v0.3.0 release artifacts
remain recorded below; v0.3.0 paired with Edge v0.9.8. This qualification
moves the CI pin to the published Ferrum Edge v0.9.9 release for the next
Foundry release. No Foundry version or release artifacts are being prepared in
this change.

## The pairing

The latest released pairing remains Foundry v0.3.0 with Edge v0.9.8, recorded
in [history](#history). This pull request evaluates v0.9.9 as the next pairing;
its image and source facts are shown in the qualification candidate below.

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | 0.3.0 (previous release: [v0.2.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.2.0)) | [v0.9.8](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.8) |
| Source commit | `b0762e61f7138de0fcabc6173308f2c6c78076e1`, the commit the `v0.3.0` tag points to, also the image's `org.opencontainers.image.revision` label | `e27f2109216352c3fe9e67a7014611f3f66daa91`, the commit the `v0.9.8` tag points to, built by Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36317719202) |
| Image | `ferrumedge/ferrum-foundry@sha256:0f8064151f264d8afafef3f581bb44c56af3c88398db21df3b65457e195ab7d6`, the release's multi-architecture index digest | `ferrumedge/ferrum-edge@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385`, the release's multi-architecture index digest |
| Platforms | `linux/amd64` `sha256:322b8ffc024d964b56b5172683b08c5f8f9abd3a61ef8718e07fbdf99099a5f3`, `linux/arm64` `sha256:7f77563d8121afa84c1f379b69ccd0d25f294dbaaa18051651ae6a9988c5dc09` | `linux/amd64` `sha256:0e629633ad55368002c415bbf76d4c91f3741519a33dd310045531d791d9a592`, `linux/arm64` `sha256:1e900bd537814fdc864ee1830bbd7a1e1f2785074a5da088a3d9cdd738b532f9` |
| CI evidence | [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36325287150), green including the Pre-publication Gates, for the tagged commit | same run, with `edge.image` at the release; qualified in [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498) |

Run Edge by digest, never by tag: `ferrumedge/ferrum-edge:latest` is not
updated for releases, and any tag can be moved. The `0.9.8-ebpf` and
`0.9.8-ebpf-tools` variants were not qualified; the `0.9.9-ebpf` and
`0.9.9-ebpf-tools` variants are separate images and are not part of this run.

## The CI pin

Every gateway-backed gate runs `edge.image`, currently the v0.9.9 qualification
candidate by its multi-architecture index digest:

| Version | Source commit | Image index | Platform manifests |
| --- | --- | --- | --- |
| [v0.9.9](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.9) | `234717ce41965cd1e2b5c6c761a25475c5d7628c` | `ferrumedge/ferrum-edge@sha256:83bb4de2ea264d5bed18d8f01f94e0e17a29b43aa1458b8984a0e9e1e784ede6` | `linux/amd64` `sha256:558fba9a1a9d7826e5ff9d84a1c80f24903c202a3a755072f45af0372ce1b477`; `linux/arm64` `sha256:33a8acceab1bee27e999b235cb24311619e44209b865cd68971cd9f3928a8379` |

Release facts: Edge [release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36806975161).
The previously supported v0.9.8 pairing remains in [history](#history).

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, which
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 introduced it; v0.9.8 and the v0.9.9 candidate
   retain it. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity behavior matches what
   Foundry's walkthrough and critical journeys assert.** Every Edge 0.9.x
   release, including v0.9.5, v0.9.7, v0.9.8, and v0.9.9, has both:
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

### Admin API changes in v0.9.9 under qualification

The release adds `GET /proxies/{id}/mcp/tools`, a viewer-readable,
namespace-scoped read of an MCP proxy's cached tool catalog. Proxy resources also
gain `allow_path_parameters` for RFC 3986 semicolon path parameters; Foundry
models and edits this flag. The capability
parity contract probes it as each role. Viewer-key namespace ceilings now
apply to namespace-scoped routes, filter the namespace registry, and deny
unlisted global routes; the deployment CI continues to exercise ordinary
trusted-proxy role and namespace claims.

Operator projections can mask plugin configuration secrets and endpoint
credentials. Edge v0.9.9 refuses a write that echoes one of its masked
placeholders before update merging. A literal `[REDACTED]` is therefore not a
round-trip marker for these resources; an operator must not save a projected
body as though it contained the stored secret. The plugin sensitivity schema
rules are unchanged from v0.9.8, and Foundry records their source commit at
v0.9.9.

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
| [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498) until this qualification | v0.9.8, `ferrumedge/ferrum-edge@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385` | The next published Edge release. Its admin API source, plugin configuration projection, and plugin scope merge are unchanged from v0.9.7 ([Admin API changes in v0.9.8](#admin-api-changes-in-v098)). Recorded as `edge.release` and moved to `edge.image` together with the Foundry v0.3.0 release preparation in [#498](https://github.com/ferrum-edge/ferrum-foundry/pull/498), whose gates are the qualification. `PLUGIN_SENSITIVITY_SOURCE` was re-read at `e27f2109216352c3fe9e67a7014611f3f66daa91`. Foundry [v0.3.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.3.0) paired with it: source commit `b0762e61f7138de0fcabc6173308f2c6c78076e1`, image `ferrumedge/ferrum-foundry@sha256:0f8064151f264d8afafef3f581bb44c56af3c88398db21df3b65457e195ab7d6` (`linux/amd64` `sha256:322b8ffc024d964b56b5172683b08c5f8f9abd3a61ef8718e07fbdf99099a5f3`, `linux/arm64` `sha256:7f77563d8121afa84c1f379b69ccd0d25f294dbaaa18051651ae6a9988c5dc09`), [release run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36325287150) |

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
- For the next Foundry release, any Ferrum Edge release other than the v0.9.9
  qualification candidate until this run passes. The released Foundry v0.3.0 /
  Edge v0.9.8 pairing remains listed in history.
- Any Ferrum Edge image other than `edge.image`, including the `0.9.9-ebpf`
  and `0.9.9-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

ferrum-edge#5661 (a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations)
was merged to Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. v0.9.8 and the v0.9.9 candidate carry it
unchanged. It is not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag.
Against the v0.9.9 candidate every item read does, so a full-replacement save
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
