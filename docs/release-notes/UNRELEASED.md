# Ferrum Foundry — next release (draft)

> **Draft.** v0.5.0 preparation also has draft versioned notes. Root must
> reconcile later main merges, finalize `docs/release-notes/v0.5.0.md`, move
> the intended changelog entries into `[0.5.0]`, and leave a fresh template here
> before tagging. The release workflow publishes the
> versioned file and refuses a tag without it. It also requires `package.json`
> and `foundry.version` in `docs/compatibility.json` to match the tag, and
> `node scripts/supported-pairing.mjs release-ready` to pass.
> Changes since [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0):
> `git log v0.4.0..vX.Y.Z`.
>
> Name a Ferrum Edge image only at the release step, using `edge.release.image`.
> If the release pairs with a different Edge release, moving the pin is a
> re-qualification; see `docs/compatibility.md` → "Changing the pairing".

*Release step:* one paragraph on who this release is for and what it changes.

### Supported pairing

| | |
| --- | --- |
| Foundry | vX.Y.Z (*release step*) — `ferrumedge/ferrum-foundry:vX.Y.Z`, `linux/amd64` and `linux/arm64` |
| Ferrum Edge | *release step* — `edge.release` from `docs/compatibility.json` |
| Tested gateway | *release step* — from `tested.gateway` |
| Tested access | *release step* — from `tested.roles` and `tested.auth_mode` |
| Tested browser | *release step* — from `tested.browsers` |
| CI evidence | *release step* — the qualification pull request and this release's Pre-publication Gates |

### Highlights since v0.4.0

*Release step:* summarize the changes from the `[Unreleased]` section of
`CHANGELOG.md`.

- **Alloy manifest preview (ferrum-alloy#27).** Settings consumes the shared v1
  JSON data model through an authenticated, namespace-authorized read-only BFF.
  Desired resource fields are bounded and TLS paths redacted; no configuration
  is applied and no producer or local file is fetched. The existing immutable
  r2 schema/fixtures remain pinned pending canonical PR #13 owner qualification
  and publication.
  Diagnostic presentation is an ADR decision for future work, not an importer.

- **Distroless runtime again (#533).** The image is back on
  `gcr.io/distroless/nodejs24-debian13:nonroot` (no shell, no package
  manager), running as `65532:65532` with Node as the entrypoint.
- **Release tags are never reassigned (GHSA-rw8r-hrr2-vpc2).** A release must
  be tagged on its unreleased candidate commit, and the release workflow
  refuses to publish over an existing `vX.Y.Z` or `X.Y.Z` image with a
  different digest or source commit. The release notes name the published
  index digest.
- Admin API resource identifiers are encoded as single path segments and
  empty or dot-segment identifiers are rejected. This fixes GHSA-64c9-hw76-jqmh.
- **Bounded long-running reads.** Apply-status long polls, backup downloads,
  and namespace-scoped namespace lists share a new admission pool, bounded per
  instance (`FERRUM_MAX_ACTIVE_LONG_READS`, default 32) and per authenticated
  subject (`FERRUM_MAX_LONG_READS_PER_PRINCIPAL`, default 8). A full pool
  answers `429` with `code: FERRUM_BFF_READ_CAPACITY`, and the apply-status
  poll waits as `Retry-After` asks. Connections to the admin API are capped at
  `FERRUM_MAX_GATEWAY_CONNECTIONS` (default 128), with readiness on its own
  small pool. The starter's nginx configurations cap in-flight API requests at
  64 per client address.
- **Bounded namespace-scoped listing.** A scoped `GET /namespaces` stops once
  every grant is found, reads at most `FERRUM_NAMESPACE_SCAN_MAX_PAGES` pages
  (default 50, 50,000 names) and otherwise answers `503` with
  `code: FERRUM_BFF_NAMESPACE_SCAN_BUDGET` rather than a partial list, and
  identical concurrent lists share one gateway read.

- **Sensitive browser reads and backup export (#543).** The browser proxy
  refuses consumer verification before signing or fetching. Intentional
  unredacted backup downloads return only safe counts to mutation state, keep
  namespace/gateway bindings, revoke URLs and sanitize failures.
- **Deployment and identity (#527, #529, #536).** Production remote admin
  connections require HTTPS and verified TLS unless the disposable-stack
  exception is set. Identity headers cannot collide; OIDC templates require an
  operator-owned session encryption secret and rotation of the old public key.
- **Namespace confirmation (#538).** A cascade must echo exactly one literal
  target namespace; malformed or ambiguous queries never reach Edge.
- **Release preparation.** v0.5.0 proposes verified Edge v0.9.11 distribution
  while preserving actual v0.4.0 facts. Metadata v2 keeps Foundry publication
  fields null and qualification pending. Exact hosted schema producer JSON/hash
  retrieval and canonical PR #13 publication precede serial pin updates.

### Known limitations

Hosted pairing acceptance remains pending. Edge #6008 (SOAP body deadlines)
and #6009 (native HTTP/3 early-body admission) are not fixed by v0.9.11.
The existing database profiles, Node floors, role tiers and scale limitations
remain unchanged; see `docs/compatibility.md`.

### Install

*Release step:* both images by digest, plus the starter and deployment links at
`vX.Y.Z`.

### Upgrading from v0.4.0

*Release step:* Edge first if the pairing moved, then Foundry; describe any
configuration changes and how to confirm `GET /api/health/ready`.

### Rolling back

*Release step:* Foundry by immutable tag or digest, Ferrum Edge by its own
guidance, and the backup to take first.
