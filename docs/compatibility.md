# Supported Foundry–Edge pairing

Foundry is qualified against **one** Ferrum Edge image at a time. Passing CI
with that image says nothing about any other Edge release, older or newer, and
Foundry does not claim otherwise. This page is the human-readable record;
[`compatibility.json`](compatibility.json) is the machine-readable one and the
single source CI reads the gateway image from.

**Record version 1 — status: release candidate.** Values marked *release step*
are filled when the release is cut, from the release run itself. They are never
guessed ahead of it.

## The pairing

| | Foundry | Ferrum Edge |
| --- | --- | --- |
| Version | *release step* (previous release: [v0.1.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0)) | [v0.9.5](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.5) |
| Source commit | *release step* — the commit `vX.Y.Z` points to, also the image's `org.opencontainers.image.revision` label | `20e76030a05dc49c3804e969516c94ab101110b9` |
| Image | *release step* — `ferrumedge/ferrum-foundry@sha256:…` from the release run | `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` |
| Platforms | `linux/amd64`, `linux/arm64` | `linux/amd64` `sha256:3bb2b253e0cc338108320a39de86da216c6e644aef39fd83a3e22ca0ad6173a8`, `linux/arm64` `sha256:d28b77e39e17e2480b3a3f39d55236f8fddbcc8cdf3dbbf314dbba6aa4ad3a1d` |
| CI evidence | *release step* — the green CI run for the tagged commit | same run |

The Edge image is the multi-architecture index Docker Hub publishes for the
`v0.9.5` tag. Run it by digest, never by tag: `ferrumedge/ferrum-edge:latest`
is not refreshed for releases, and any tag can be moved.

## Tested support

Everything here runs on every pull request and again, through the reusable
workflow, before a release is published.

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

`scripts/capability-parity-contract.mjs` asks the pinned gateway the questions
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
- Any Ferrum Edge image other than the one above, including newer releases.
- Atomic concurrent-edit protection — see below.
- Browser latency, and more than one operator editing at scale.

## Dependency on unreleased Ferrum Edge work

**ferrum-edge#5661** — a strong `ETag` on resource reads and `If-Match` on
`PUT`/`DELETE` of proxies, upstreams, consumers, and plugin configurations —
was merged on Ferrum Edge `main` as `e55ce01893c25bd802cb4f10831c07ca32b3deda`
on 2026-09-23. It is **not** in v0.9.5 or in any published Edge image.

Foundry already sends `If-Match` whenever a read carries a strong tag
(#404, #405). Against v0.9.5 no read does, so the write guard verifies the
resource immediately before every full-replacement write and then sends it
unconditionally: a stale editor can no longer revert a newer change, but a
writer that commits within that one round trip is not detected
(`docs/concurrent-edits.md`). The pairing is therefore qualified for
supervised operation with few concurrent administrators. Moving `edge.image`
to a published release that includes #5661 turns the atomic path on without a
Foundry change, and the concurrent-edit contract then asserts the `412`s.

## Changing the pairing

Moving the Edge pin is a re-qualification, not a tag edit:

1. Choose a **published** Edge release, and read its multi-architecture index
   digest and per-platform manifest digests from the registry.
2. Change `edge` in `docs/compatibility.json`, the `demo-gateway` image in
   `deploy/starter/compose.yaml`, the local-run command in `CLAUDE.md`, the
   tables on this page, and the draft release notes.
   `scripts/supported-pairing.test.mjs` fails until every one of them agrees,
   and finds any other file still naming a different Edge image.
3. Open a pull request. Every gateway-backed gate — contract, capability
   parity, starter, critical journeys, container — runs against the new image.
   A failure is a compatibility finding to review, not a test to relax.

Move the old image to `edge.retired_images`; its digest may then appear only
in history (`CHANGELOG.md`, this page, published release notes).

## Retired pins

| Image | What it was | Retired by |
| --- | --- | --- |
| `ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d` | Development build `main-b96cfaadd41a676d39a409d47b48e0b0588fa86e` (2026-08-27), never a published release | #385 |
