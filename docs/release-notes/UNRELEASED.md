# Ferrum Foundry — next release (draft)

> **Draft.** The release step renames this file to `docs/release-notes/vX.Y.Z.md`,
> replaces every *release step* marker, and removes this note. The release
> workflow publishes that file as the GitHub release body and refuses a tag
> without it. Changes since [v0.1.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0):
> `git log v0.1.0..vX.Y.Z`.
>
> **Blocked on the next Ferrum Edge release.** No published Edge release
> qualifies yet. Ferrum Edge v0.9.5 was evaluated and fails the Deployment
> Starter walkthrough and a critical journey
> ([CI run 35901872338](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/35901872338)).
> The pairing needs the next published Edge release. It must include
> ferrum-edge#5661, agree with Foundry's walkthrough and critical journeys on
> proxy-association and namespace-identity semantics, and pass the full
> qualification before this release is published: Quality Gate, Pinned Gateway
> Contract (including capability parity), Deployment Starter, Critical
> Journeys, and Container Gate. The requirements are in `docs/compatibility.md`
> ("The Edge release to pair with"). The release workflow refuses the tag until
> `edge.release` is recorded and CI runs it.

This is the first Foundry release qualified against an explicit Ferrum Edge
release. It is intended for a **supervised early-access deployment**: one
gateway, a small number of administrators, the documented identity-proxy
topology. It makes no compatibility promise for other Edge releases or for
earlier Foundry development builds.

### Supported pairing

| | |
| --- | --- |
| Foundry | vX.Y.Z (*release step*) — `ferrumedge/ferrum-foundry@sha256:…` (*release step*), `linux/amd64` and `linux/arm64` |
| Ferrum Edge | *release step* — the next published Ferrum Edge release after v0.9.5 that includes ferrum-edge#5661 and passed the full qualification, with its multi-architecture index digest from `docs/compatibility.json` `edge.release.image` |
| Tested gateway | `database` mode on SQLite, writable and with `FERRUM_ADMIN_READ_ONLY=true`; admin JWT with audience and namespace-claim enforcement |
| Tested access | `trusted-proxy` authentication through the starter's identity proxy; `viewer`, `operator`, and `admin` |
| Tested browser | Chromium (the build bundled with Playwright 1.63.0) |
| CI evidence | *release step* — the green CI run for the tagged commit |

Best-effort: PostgreSQL/MySQL `database` mode, `cp` mode, other browsers,
Kubernetes. Not qualified: `file`/`dp`/`mesh`/`node_agent` modes (so the mesh,
waypoint, trust, and chargeback pages), and any other Edge image. The full
envelope, including tested scale, is in
[`docs/compatibility.md`](https://github.com/ferrum-edge/ferrum-foundry/blob/vX.Y.Z/docs/compatibility.md).

### Highlights since v0.1.0

**Safer writes**

- Full-replacement saves of proxies, upstreams, upstream targets, consumers,
  and plugin configurations, and deletes from their detail pages, are refused
  when the resource changed since the editor opened, instead of silently
  reverting another administrator's change. The draft is kept and shown against
  the current gateway content, with secrets redacted at every depth. There is
  no "save anyway" and nothing is re-sent automatically (#381).
- A write whose outcome Foundry could not observe (a lost response, a timeout,
  a dropped connection) is reported as an unknown outcome and never replayed;
  reads are retried only when safe.
- A proxy-scoped plugin created through the UI is verified to be attached to
  its proxy, and attached when the gateway left it unattached.

**Truthful reads**

- A failed or unavailable read is distinguishable from an empty collection
  across policy, trust, mesh, dashboard, audit, and API-spec views, and editors
  keep unsaved fields through failed background reads.
- A read the gateway refuses to the session's role (for example TLS inventory
  for a `viewer`) is shown as a denial, never as an empty store.
- Ordinary navigation is bounded: the proxy list fetches one page instead of
  whole collections (#382).

**Access and tenancy**

- A client-side capability model presents surfaces a role or a read-only
  gateway cannot write as read-only, with the reason visible before anything
  is edited. CI now checks that model against the pinned gateway as every
  role, writable and read-only.
- Every gateway request is bound to the namespace its operation started in;
  editors are bound to namespace and resource so a tenant switch cannot submit
  stale fields.

**Operating Foundry**

- A maintained deployment starter (`deploy/starter/`) with a production and a
  disposable demo profile, a preflight that reports unknowns honestly, and a
  first-success walkthrough (#384).
- A critical-journey release gate: a real browser against the production image,
  the identity proxy, and the pinned gateway, finishing with data-plane
  requests (#380).
- Guided configuration for `key_auth`, `rate_limiting`, `cors`, and
  `prometheus_metrics`, lossless against the raw JSON editor (#383).
- Proxied uploads are bounded by an absolute deadline
  (`FERRUM_UPLOAD_TIMEOUT`) and a global in-flight cap
  (`FERRUM_MAX_ACTIVE_UPLOADS`).

The complete list is in
[`CHANGELOG.md`](https://github.com/ferrum-edge/ferrum-foundry/blob/vX.Y.Z/CHANGELOG.md).

### Known limitations

- **Atomic concurrent edits need ferrum-edge#5661.** Strong `ETag` and
  `If-Match` on resource writes were merged on Ferrum Edge `main` on 2026-09-23
  but are in no published image yet, and the paired Edge release must include
  them. Against a gateway without them, the write guard re-verifies the
  resource immediately before each write. A stale editor cannot revert a newer
  change, but a writer that commits within that one round trip is not
  detected. Foundry already sends `If-Match`, so the paired release closes the
  gap without a Foundry change.
- **Ferrum Edge v0.9.5 is not supported.** It was evaluated and fails the
  starter walkthrough and a critical journey. It attaches a proxy-scoped plugin
  configuration to its proxy on write (ferrum-edge#4611), and it accepts a
  resource id already used in another namespace. It also lacks #5661.
- **One qualified gateway configuration.** Modes other than `database`, and Edge
  releases other than the paired one, have not been run in CI.
- **Scale.** Real-gateway testing covers tens of resources per namespace.
  Request budgets are measured at 50,000 records against a synthetic gateway;
  browser latency is not measured. List search still traverses the
  collection, because the admin API offers no server-side search.
- **One browser.** Only Chromium runs in the release gate.

### Install

Run the pairing above, both by digest. The Ferrum Edge image is
`edge.release.image` in `docs/compatibility.json` (*release step*: write it
out here too).

```bash
docker pull ferrumedge/ferrum-foundry@sha256:<release step>
```

- New deployment: follow [Getting started](https://github.com/ferrum-edge/ferrum-foundry/blob/vX.Y.Z/docs/getting-started.md)
  with the starter, then [Deployment](https://github.com/ferrum-edge/ferrum-foundry/blob/vX.Y.Z/docs/deployment.md)
  for the production checklist. Set `FOUNDRY_IMAGE` to the Foundry digest; the
  starter's default (`:main`) is the development channel.
- `FERRUM_JWT_SECRET` must equal the gateway's `FERRUM_ADMIN_JWT_SECRET`, and
  `FERRUM_JWT_AUDIENCE` its `FERRUM_ADMIN_JWT_AUDIENCE`.

### Upgrading from v0.1.0

Foundry keeps no persistent state of its own, so an upgrade is an image
replacement. v0.1.0 was published during buildout and is not supported; there
is no migration and no compatibility promise between the two.

1. Move the gateway to the paired Ferrum Edge release (*release step*) first, following Ferrum Edge's own
   upgrade guidance. Foundry is not qualified against the gateway you ran with
   v0.1.0.
2. Review new BFF settings in `docs/deployment.md` (`FERRUM_UPLOAD_TIMEOUT`,
   `FERRUM_MAX_ACTIVE_UPLOADS`); their defaults are safe.
3. Replace the Foundry image with the release digest and confirm
   `GET /api/health/ready` reports the new version and a reachable gateway.
4. Reload open browser tabs so they run the new SPA bundle.

### Rolling back

- **Foundry:** redeploy the previous immutable tag or digest. Nothing Foundry
  wrote needs undoing — configuration lives in Ferrum Edge — but a rollback
  does not revert configuration changes made through the newer version, and
  the previous version is not qualified against the paired Ferrum Edge release.
- **Ferrum Edge:** follow Ferrum Edge's own rollback guidance and restore the
  configuration from a backup taken before the upgrade. Take one per namespace
  with Settings → Download Backup (`GET /backup`, admin role) before either
  upgrade.
- Confirm `FERRUM_JWT_SECRET` and `FERRUM_JWT_AUDIENCE` still match the gateway
  after any rollback.
