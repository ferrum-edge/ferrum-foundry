# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge build, older or newer, and
Foundry does not claim otherwise. This page is the human-readable record;
[`compatibility.json`](compatibility.json) is the machine-readable one and the
single source CI reads the gateway image from.

**Record version 1 — status: release candidate.** Values marked *release step*
are filled when the release is cut, from the release run itself. They are never
guessed ahead of it.

**No published Ferrum Edge release is paired yet.** CI runs the published
Ferrum Edge v0.9.5 release ([the CI pin](#the-ci-pin)), but v0.9.5 does not
include ferrum-edge#5661, so it cannot be the supported pairing. The first
supported pairing needs the **next** published Edge release — one that meets
every requirement under
[The Edge release to pair with](#the-edge-release-to-pair-with). Until that
release exists and is qualified, the release workflow refuses to tag a Foundry
release.

## The pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | *release step* (previous release: [v0.1.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0)) | *release step* — the next published Ferrum Edge release after v0.9.5 that meets the requirements below |
| Source commit | *release step* — the commit `vX.Y.Z` points to, also the image's `org.opencontainers.image.revision` label | *release step* — the commit that Edge release tag points to |
| Image | *release step* — `ferrumedge/ferrum-foundry@sha256:…` from the release run | *release step* — `ferrumedge/ferrum-edge@sha256:…`, the release's multi-architecture index digest |
| Platforms | `linux/amd64`, `linux/arm64` | *release step* — the release's `linux/amd64` and `linux/arm64` manifest digests |
| CI evidence | *release step* — the green CI run for the tagged commit | same run, with `edge.image` moved to the release |

Run Edge by digest, never by tag: `ferrumedge/ferrum-edge:latest` is not
refreshed for releases, and any tag can be moved.

## The CI pin

Every gateway-backed gate runs `edge.image`:

| | |
| --- | --- |
| Image | `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` |
| What it is | The published [Ferrum Edge v0.9.5](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.5) release, by its multi-architecture index digest |
| Source commit | `20e76030a05dc49c3804e969516c94ab101110b9`, the commit the `v0.9.5` tag points to, built by Edge's [Release run](https://github.com/ferrum-edge/ferrum-edge/actions/runs/34795503690) |
| Platforms | `linux/amd64` `sha256:3bb2b253e0cc338108320a39de86da216c6e644aef39fd83a3e22ca0ad6173a8`, `linux/arm64` `sha256:d28b77e39e17e2480b3a3f39d55236f8fddbcc8cdf3dbbf314dbba6aa4ad3a1d` |

CI runs a real published gateway, with the proxy-association and
namespace-identity semantics every Edge 0.9.x release and Edge `main` share.
It is **not** a supported pairing: it does not include ferrum-edge#5661.
[History](#history) records the pins before it.

## The Edge release to pair with

The first supported pairing requires the **next published** Ferrum Edge
release, and it qualifies only if:

1. **It includes ferrum-edge#5661**: a strong `ETag` on resource reads and
   `If-Match` on `PUT`/`DELETE` of proxies, upstreams, consumers, and plugin
   configurations. See
   [Dependency on unreleased Ferrum Edge work](#dependency-on-unreleased-ferrum-edge-work).
2. **Its proxy-association and namespace-identity semantics are the ones
   Foundry's walkthrough and critical journeys assert.** Both are in every Edge
   0.9.x release, in v0.9.5 (`edge.image`), and on Edge `main`:
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
| #409 onward | v0.9.5, the same digest | Foundry's walkthrough, namespace-isolation journey, and documentation were aligned with the Edge 0.9.x semantics, and v0.9.5 moved from `edge.rejected_images` to `edge.image`. It still lacks ferrum-edge#5661, so it is the CI pin, not the supported pairing |

## Tested support

Everything here runs on every pull request and again, through the reusable
workflow, before a release is published. It runs against `edge.image`
(v0.9.5) until the pairing release is qualified.

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

- every gateway-backed surface gets a **non-mutating** probe that passes
  through the same role check and write gate as the surface's real writes — a
  `DELETE` of an id that does not exist, `POST /admin/tls/validate`,
  `GET /backup`, or a `POST /restore` with no `?confirm=true` and a body that is
  not JSON;
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
- Any published Ferrum Edge release as a supported pairing, until the pairing
  release is recorded and qualified. v0.9.5 is the CI pin but lacks
  ferrum-edge#5661.
- Any Ferrum Edge image other than `edge.image`.
- Atomic concurrent-edit protection — see below.
- Browser latency, and more than one operator editing at scale.

## Dependency on unreleased Ferrum Edge work

**ferrum-edge#5661** — a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations —
was merged on Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23. It is **not** in v0.9.5, in any published Edge image, or in
`edge.image`.

Foundry already sends `If-Match` whenever a read carries a strong tag
(#404, #405). Against v0.9.5 no read does, so the write guard verifies the
resource immediately before every full-replacement write and then sends it
unconditionally: a stale editor can no longer revert a newer change, but a
writer that commits within that one round trip is not detected
(`docs/concurrent-edits.md`). A published release that includes #5661 is a
requirement of the pairing. Moving `edge.image` to it turns the atomic path on
without a Foundry change, and the concurrent-edit contract then asserts the
`412`s.

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
