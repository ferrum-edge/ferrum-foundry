# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer, and
Foundry does not claim otherwise. This page is the human-readable record;
[`compatibility.json`](compatibility.json) is the machine-readable one and the
single source CI reads the gateway image from.

**Record version 1 — status: release candidate for Foundry v0.2.0.** Values
marked *release step* are filled when the release is cut, from the release run
itself. They are never guessed ahead of it.

**Foundry v0.2.0 pairs with the published Ferrum Edge v0.9.7 release.** It is
the first published Edge release after v0.9.5 (`v0.9.6` was tagged but never
published) and the first that includes ferrum-edge#5661, the requirement that
kept v0.9.5 from being a pairing. `edge.image` and `edge.release` name the same
image, so every gateway-backed gate runs against the release Foundry pairs
with. [#439](https://github.com/ferrum-edge/ferrum-foundry/pull/439), which
moved the pin to it, is the qualification run
([Changing the pairing](#changing-the-pairing)).

## The pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | 0.2.0 (previous release: [v0.1.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0)) | [v0.9.7](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.7) |
| Source commit | *release step* — the commit `v0.2.0` points to, also the image's `org.opencontainers.image.revision` label | `8fed1346ce2e267eb69c03683cb89ea44d785e0b`, the commit the `v0.9.7` tag points to, built by Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36110533284) |
| Image | *release step* — `ferrumedge/ferrum-foundry@sha256:…` from the release run | `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a`, the release's multi-architecture index digest |
| Platforms | `linux/amd64`, `linux/arm64` | `linux/amd64` `sha256:e4d4367e815e86f510c28d8f831ca3502b7c9d5f21fd0eeabeb609a8c8e6f47f`, `linux/arm64` `sha256:7d3d28d2529dfb6a303b734fad0bf35ebec07caa95f5632e81d92170baf15fab` |
| CI evidence | *release step* — the green CI run for the tagged commit | same run, with `edge.image` at the release; qualified in [#439](https://github.com/ferrum-edge/ferrum-foundry/pull/439) |

Run Edge by digest, never by tag: `ferrumedge/ferrum-edge:latest` is not
refreshed for releases, and any tag can be moved. The `0.9.7-ebpf` and
`0.9.7-ebpf-tools` variants are different images and are not qualified.

## The CI pin

Every gateway-backed gate runs `edge.image`, which is the paired release:

| | |
| --- | --- |
| Image | `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a` |
| What it is | The published [Ferrum Edge v0.9.7](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.7) release, by its multi-architecture index digest |
| Source commit | `8fed1346ce2e267eb69c03683cb89ea44d785e0b`, the commit the `v0.9.7` tag points to, built by Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/36110533284) |
| Platforms | `linux/amd64` `sha256:e4d4367e815e86f510c28d8f831ca3502b7c9d5f21fd0eeabeb609a8c8e6f47f`, `linux/arm64` `sha256:7d3d28d2529dfb6a303b734fad0bf35ebec07caa95f5632e81d92170baf15fab` |

[History](#history) records the pins before it.

## The Edge release to pair with

A Foundry release pairs with one **published** Ferrum Edge release, and it
qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. v0.9.7 does. See
   [Conditional writes on the paired release](#conditional-writes-on-the-paired-release).
2. **Its proxy-association and namespace-identity semantics are the ones
   Foundry's walkthrough and critical journeys assert.** Both are in every Edge
   0.9.x release, including v0.9.5 and v0.9.7:
   - Edge attaches the proxy association itself when a proxy-scoped plugin
     configuration is written (ferrum-edge#4611).
     `scripts/starter-journey.mjs` asserts that the plugin configuration
     protects the route as soon as it is created, and that attaching it again
     by hand changes nothing.
   - Edge keys proxies, upstreams, plugin configurations, and API specs on
     `(namespace, id)` (ferrum-edge `5db1d77a8`).
     `e2e/journeys/namespace-isolation.spec.ts` asserts that two namespaces
     holding the same id stay isolated for reads, writes, deletes, and the UI.

   Foundry was aligned with both in #409. A release that changes either must
   pass the gates without weakening what they check.
3. **The full qualification is re-run against it.** The pull request that sets
   `edge.release` and moves `edge.image` to that release must pass every job
   before any Foundry release is published: Quality Gate, Pinned Gateway
   Contract (including capability parity, writable and read-only), Deployment
   Starter, Critical Journeys, and Container Gate.

`node scripts/supported-pairing.mjs release-ready` enforces the recorded half
of this. The release workflow runs it, and it refuses a tag while
`edge.release` holds *release step* placeholders or `edge.image` is not that
release.

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
  set. Foundry uses it for a proxy's Plugins tab (`docs/data-loading.md`).
- **Stricter validation.** An upstream's active health check `http_path` must
  start with `/`, and `udp_probe_payload` must be even-length hex. The upstream
  form checks both before submitting, and the mock gateway refuses them with
  `400`. Other new startup and configuration refusals (non-finite `FERRUM_*`
  floats, `FERRUM_MAX_CREDENTIALS_PER_TYPE=0`, mesh listener ports, Redis URL
  database selectors, `ECHCONFIG` blocks in `mtls_auth` CA bundles) are gateway
  deployment settings or plugin configuration Foundry passes through unchanged;
  the gateway's `400` is shown as returned.
- **Diagnostic wording.** The upgrade guide asks tooling that matches exact
  error text to update. Plugin configuration refusals now quote field names
  and values with backticks and double quotes rather than single quotes. The
  gateway contract records each default-template rejection as a whole string
  (`docs/plugin-defaults.md`), so the five affected expectations were re-recorded
  from the pinned gateway; the comparison is still exact.

## Evaluated and rejected

No Edge image is currently rejected (`edge.rejected_images` is empty). A
rejected digest may appear only in history (`CHANGELOG.md`, this page,
`compatibility.json`, published release notes).
`scripts/supported-pairing.test.mjs` fails if any other file names it.

## History

| Period | `edge.image` | What happened |
| --- | --- | --- |
| Until #409 | `ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d` — development build `main-b96cfaadd41a676d39a409d47b48e0b0588fa86e` (2026-08-27) from Ferrum Edge `main`, never a published release (source commit recorded by Edge's [Docker Manifest job](https://github.com/ferrum-edge/ferrum-edge/actions/runs/33094251786/job/98636370391); `linux/amd64` `sha256:8dc20df77ddf636052bf3191d1584e50ef082db8a5736f495fca9fa078d69c29`, `linux/arm64` `sha256:15bce0a914efca89dbce076dd1617f4a9571717e3fb8493bc38dd56b4d73df20`) | The interim pin. It predates ferrum-edge#4611 and `5db1d77a8`, and the walkthrough and namespace-isolation journey asserted its behaviour: a proxy-scoped plugin configuration did not protect the route until the proxy was updated by hand, and a second namespace could not reuse an id (`409`) |
| #385 evaluation | v0.9.5, `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` | Recorded as rejected. Deployment Starter failed the first-success walkthrough because a proxy-scoped `key_auth` config took effect before the walkthrough attached it (`401`, expected `200`; ferrum-edge#4611). Critical Journeys failed "a resource id cannot be reused in another namespace" (`201`, expected `409`; ferrum-edge `5db1d77a8`). Quality Gate, Pinned Gateway Contract (including capability parity), and Container Gate passed ([CI run 35901872338](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/35901872338)). Both failures were Foundry assertions encoding pre-0.9 behaviour, not Edge defects |
| #409 until the v0.9.7 pin | v0.9.5, the same digest (source commit `20e76030a05dc49c3804e969516c94ab101110b9`, Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/34795503690); `linux/amd64` `sha256:3bb2b253e0cc338108320a39de86da216c6e644aef39fd83a3e22ca0ad6173a8`, `linux/arm64` `sha256:d28b77e39e17e2480b3a3f39d55236f8fddbcc8cdf3dbbf314dbba6aa4ad3a1d`) | Foundry's walkthrough, namespace-isolation journey, and documentation were aligned with the Edge 0.9.x semantics, and v0.9.5 moved from `edge.rejected_images` to `edge.image`. It lacked ferrum-edge#5661, so it was the CI pin, never a supported pairing: the write guard verified before each write and sent it unconditionally |
| [#439](https://github.com/ferrum-edge/ferrum-foundry/pull/439) onward | v0.9.7, `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a` | The first published Edge release after v0.9.5 (v0.9.6 was tagged but never published) and the first with ferrum-edge#5661. Recorded as `edge.release` and moved to `edge.image` in #439, whose gates are the qualification. The gateway contract now requires the `ETag`s, the `412`s, and the strict-`If-Match` `400`s, and the proxy Plugins tab reads `GET /plugins/config?proxy_id=` (ferrum-edge#5726) |

## Tested support

Everything here runs on every pull request and again, through the reusable
workflow, before a release is published. It runs against `edge.image`, the
paired Ferrum Edge v0.9.7 release.

| Dimension | Qualified | Evidence |
| --- | --- | --- |
| Gateway mode | `database` on SQLite, admin writes enabled, admin JWT with audience and `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` | Pinned Gateway Contract, Deployment Starter, Critical Journeys, Container Gate |
| Read-only admin API | `database` started with `FERRUM_ADMIN_READ_ONLY=true` | Pinned Gateway Contract — capability parity, read-only half |
| Roles | `viewer`, `operator`, `admin` | capability parity (every surface and the launch reads, per role); critical journeys through the identity proxy |
| Authentication | `trusted-proxy` behind the starter's nginx identity proxy, with the shared group-to-role policy | Deployment Starter, Critical Journeys |
| Deployment path | `deploy/starter` (Compose) with the production Foundry image | Deployment Starter, Critical Journeys |
| Browser | Chromium bundled with `@playwright/test` 1.63.0, Desktop Chrome profile | Critical Journeys |
| Container platforms | `linux/amd64`, `linux/arm64` | Container Gate (both builds start and serve a protected request) |
| BFF Node.js | 22 and 24 (the image ships 24) | Quality Gate matrix |

### Tested scale

Scale claims stop at what has been measured.

- **Against the real gateway:** the demo seed and contract fixtures — tens of
  resources per namespace, across two namespaces. No larger installation has
  been run against a real gateway.
- **Request budget, synthetic:** `src/api/dataLoadingBudget.test.ts` counts
  requests and response bytes at 500 and at 50,000 records per collection
  against a synthetic gateway (`docs/data-loading.md`). That is not browser
  latency, and no latency is claimed.

## Capability parity

`scripts/capability-parity-contract.mjs` asks the pinned gateway (`edge.image`) the questions
the UI's capability model (`src/lib/capabilities.ts`) answers, as each role:

- every gateway-backed surface gets a probe that passes through the same role
  check and write gate as the surface's real writes — a `DELETE` of a reserved
  id, `POST /admin/tls/validate`,
  `GET /backup`, or a `POST /restore` with no `?confirm=true` and a body that is
  not JSON. Every admitted `DELETE` must return `404`; writable execution is
  allowed only after `FERRUM_DEMO_CONFIRM_TARGET` exactly identifies the
  disposable gateway and namespace;
- the model's verdict and the gateway's answer must agree: allowed means not
  refused, a role denial must name the same required role, and a read-only
  denial must be the gateway's read-only refusal;
- every role must receive real collections for proxies, upstreams, consumers,
  plugin configs, and namespaces, and a read the gateway withholds from a role
  (TLS inventory and gateway trust bundles below `operator`, the audit log below
  `admin`) must be an explicit `403` naming the role. Foundry renders that as a
  denial, never as an empty collection or as a feature the gateway lacks.

The writable half runs inside `npm run test:gateway-contract`; the read-only
half runs against a second container of the same image started with
`FERRUM_ADMIN_READ_ONLY=true`, and first proves from `/health` that the gateway
really is read-only, so it cannot pass vacuously.

## Best-effort

Expected to work because nothing Foundry does depends on them, but not run in
CI. Report problems; they are not release blockers.

- `database` mode on PostgreSQL or MySQL.
- `cp` (control-plane) mode.
- Other Chromium-based browsers, Firefox, and Safari.
- Kubernetes or any other deployment that reproduces the documented
  trusted-proxy contract (`docs/deployment.md`).
- Static-token authentication — development only.

## Not qualified

- `file`, `dp`, `mesh`, and `node_agent` gateway modes. The UI models them as
  read-only (`docs/capabilities.md`), and the mock admin gateway reproduces
  that, but no real gateway in those modes runs in CI. The mesh, waypoint,
  trust, and chargeback pages are therefore unqualified.
- Any Ferrum Edge release other than v0.9.7, older or newer. Passing CI with
  v0.9.7 says nothing about the release after it.
- Any Ferrum Edge image other than `edge.image`, including the `0.9.7-ebpf`
  and `0.9.7-ebpf-tools` variants of the same release.
- Browser latency, and more than one operator editing at scale.

## Conditional writes on the paired release

**ferrum-edge#5661** — a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations —
was merged on Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23 and released in v0.9.7. It was not in v0.9.5.

Foundry sends `If-Match` whenever its verification read carries a strong tag
(#404, #405). Against v0.9.7 every item read does, so a full-replacement save
or a detail-page delete is atomic: a writer that commits between the guard's
verification read and the write is refused with `412` and nothing is written
(`docs/concurrent-edits.md`). A read with no strong tag — the cached-config
fallback (`X-Data-Source: cached`) — still gets an unconditional write that
narrows the race to one round trip rather than closing it.
`scripts/concurrent-edit-contract.mjs` requires the pinned gateway to issue the
tags, refuse a stale and an invented tag with `412`, and refuse a malformed
`If-Match` and one on a create with `400`.

## Changing the pairing

Moving the Edge pin is a re-qualification, not a tag edit:

1. Choose a **published** Edge release that meets the
   [requirements](#the-edge-release-to-pair-with). Read its multi-architecture
   index digest and per-platform manifest digests from the registry.
2. Fill `edge.release` in `docs/compatibility.json`, and move `edge.image`,
   `edge.source_commit`, and `edge.platform_manifests` to the same release.
   Update the `demo-gateway` image in `deploy/starter/compose.yaml`, the
   local-run command in `CLAUDE.md`, the tables on this page, and the draft
   release notes. `scripts/supported-pairing.test.mjs` fails until every one of
   them agrees, and finds any other file still naming a different Edge image.
3. Open a pull request. Every gateway-backed gate — contract, capability
   parity, starter, critical journeys, container — runs against the new image.
   A failure is a compatibility finding to review, not a test to relax.

If the candidate fails, restore the previous `edge.image`, record the candidate
in `edge.rejected_images` with its finding and CI run, and add it to
[Evaluated and rejected](#evaluated-and-rejected).
