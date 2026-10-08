# Release and supply-chain gates

No image or GitHub release is published until every job in the reusable CI
workflow (`.github/workflows/ci.yml`) has passed:

1. **Quality Gate** (Node 22 and 24): zero-warning lint, frontend, server, and
   E2E type checks, the full test suite with coverage floors, a
   production-dependency audit (`npm audit --omit=dev --audit-level=high`), and
   a production build.
2. **Pinned Gateway Contract**: runs against the Ferrum Edge image pinned as
   `edge.image` in `docs/compatibility.json`, with admin JWT audience and
   namespace-claim enforcement on. It checks the guided plugin schemas and the
   plugin sensitivity table against their pinned sources, admits every
   [plugin template](plugin-defaults.md), seeds the same destructive demo
   payload twice, verifies the exported backup state, and sends live public,
   anonymous (must be rejected), key, basic, JWT, multi-auth, and response-mock
   traffic. It also compares the UI's capability model with the gateway's
   answers as `viewer`, `operator`, and `admin`, on that image and on a second
   copy started with `FERRUM_ADMIN_READ_ONLY=true`.
3. **Deployment Starter** and **Critical Journeys**: bring up the checked-in
   starter with the freshly built image and the same gateway image, then run the
   first-success walkthrough and the [browser journeys](../e2e/README.md).
4. **Container Gate** (amd64 and arm64): builds the release Dockerfile, checks
   that a planted `.env` canary is absent from image history and layers,
   requires a numeric non-root user and runs Node as the entrypoint to prove
   the process is not root and that there are no Node package managers (npm,
   npx, corepack, yarn) in the image, checks liveness, readiness, and one
   authenticated BFF-to-gateway request, fails on fixable high or critical
   vulnerabilities, and uploads a CycloneDX SBOM per architecture.

## Supported Edge image

Passing these gates qualifies Foundry with that one Ferrum Edge image and no
other build. The Foundry v0.5.3 candidate selects published Edge v0.9.14 and
published `contracts-edge-0.9.14`; its full pairing qualification and
publication are pending in
[the compatibility record](compatibility.md#qualification-evidence).
Published v0.5.2 / Edge v0.9.13, v0.5.1 / Edge v0.9.12, v0.5.0 / Edge v0.9.11
and v0.4.0 / Edge v0.9.10 pairings remain immutable in
[history](compatibility.md#history).

Moving the pin is a re-qualification: change `edge.image` in
`docs/compatibility.json`, and the pull request re-runs every gate above against
the new image. `scripts/supported-pairing.test.mjs` fails if any file outside the
history files names a different Ferrum Edge image, or if the starter Compose file
or `CLAUDE.md` does not name `edge.image`.

## Build inputs

The Docker build context is deny-by-default (`.dockerignore`). Only package
manifests, TypeScript and Vite configuration, `src/`, `server/`, `shared/`, and
`public/` are sent. `.env` files, Git history, documentation, build output,
coverage, and caches never enter the context.

The Dockerfile frontend, the Node 24 builder, and the Node 24 runtime are pinned
by multi-platform image digest. The image's OCI revision label is the Git commit
being built.

The runtime is `gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by its
multi-platform index digest. It has no shell, no OS package manager, and no
Node package managers (npm, npx, corepack, yarn); Node at `/nodejs/bin/node` is
the entrypoint, and the process runs as UID/GID `65532:65532`. The runtime
stage only copies the built application in, so the base digest and the source
commit identify every runtime input; nothing is fetched from a package feed at
build time. The SBOM attached to each published image records the package
versions it contains.

Every third-party GitHub Action is pinned to a full commit SHA.

## Publishing

For v0.5.2, the reviewed release preparation landed in protected **merge
commit** `ebd09e8d82f773b6840b1edda67fbac287c3f7a0`, whose second parent was
`8f324c52bcf2a48e9532d0fabb46ee2036f3075b`. Qualification run `37511649961`,
attempt 1, binds source `bc7ca925b68eac86a42bc394bbf9f25e47efffc0` to tested
merge `f9703947f384a642b9f7144e6be87e8e68b7a8e5`. Release run `37514033958`
succeeded; GitHub release `405045848` was published at 2026-10-06 18:55:40 UTC.
The immutable release record contains the tag source, final multi-architecture
image index, platform digests and CI evidence. The supplied publication evidence
does not establish anonymous GHCR access, independent cryptographic attestation
verification or account-level registry immutability. See the
[v0.5.2 record](release-notes/v0.5.2.compatibility.json) and
[compatibility record](compatibility.md). Earlier release notes and records
remain unchanged.

Pushes to `main` and release tags publish multi-architecture images with
BuildKit provenance (`mode=max`) and SBOM attestations. Each manifest job
requires exactly two per-platform digests, checks that they are `linux/amd64`
and `linux/arm64`, publishes and re-checks the immutable tag, and only then
moves channel tags.

| Trigger | Immutable tag | Channel tags |
| --- | --- | --- |
| Push to `main` | `main-<commit>` | `main` |
| Release tag `vX.Y.Z` | `vX.Y.Z` and `X.Y.Z`, never reassigned | `X.Y` if it is the newest patch in that line; `latest` if it is the newest stable version |

A prerelease tag (`vX.Y.Z-suffix`) is marked as a prerelease on GitHub and never
moves `X.Y` or `latest`. An untagged commit or an older stable backport can
therefore never replace what `docker pull ferrumedge/ferrum-foundry` returns.

Before any registry login or build, the release workflow requires that:

- the tag is a safe semantic version, names the commit the run builds
  (`GITHUB_SHA`), and that commit is reachable from `main`;
- `package.json` `version` equals the tag without its `v` (`v1.2.3` needs
  `1.2.3`), because the BFF reports it from `/api/health/live` and
  `/api/health/ready`;
- `foundry.version` in `docs/compatibility.json` equals that version;
- `docs/release-notes/vX.Y.Z.md` exists and is not empty;
- `node scripts/supported-pairing.mjs release-ready` passes in hosted Actions:
  `edge.release` names
  a published Edge release and `edge.image` is that release, and the record is
  still the unreleased `candidate`, with `foundry.source_commit`, `image`, and
  `ci_evidence` null, and `qualification` names its verified successful hosted
  CI run, attempt, actual head and tested checkout SHA. The metadata job uses
  only `actions: read` and `contents: read` for those GitHub API reads. It
  requires every pairing job and checkout-identity job to pass in that attempt,
  complete source trees, matching pairing records, PR merge-parent binding and
  release ancestry. The immutable checkout job captures the original source,
  base and main ref; live embedded PR metadata cannot invalidate historical
  evidence after its evidence-only commit. API failure is a fixed, redacted
  refusal. After the earlier pending source passes, only its `qualification`
  object may change: other code, pin, workflow, record or documentation changes
  require qualification again. See
  [qualification recording](compatibility.md#qualification-evidence);
- the version has no GitHub release yet;
- neither `vX.Y.Z` nor `X.Y.Z` exists on Docker Hub or GHCR with an image whose
  `org.opencontainers.image.revision` is another commit
  (`node scripts/release-image-identity.mjs preflight`, read anonymously).

The GitHub release is published with those notes. Release runs for different
tags are queued independently: each manifest job waits for earlier release runs
to finish, and tags are re-fetched just before image promotion and GitHub
release creation, so a slower older run cannot overwrite a newer one.

### Release version tags are never reassigned

`vX.Y.Z` and `X.Y.Z` name one image, built from one commit, for good
(GHSA-rw8r-hrr2-vpc2). The workflow enforces this itself rather than relying on
registry settings alone:

- **The tag is bound to the commit.** The tag must name `GITHUB_SHA` when the
  run starts, and again (re-fetched from the remote) just before the manifest
  job logs in to a registry and before the GitHub release is created. A tag
  moved during the run stops it.
- **A released record cannot be released again.** The release step records the
  Foundry artifacts and marks `docs/compatibility.json` `released` on `main`
  after publication (a commit cannot name its own hash, so the tagged commit
  carries the `candidate` record). `release-ready` refuses a `released` record,
  so a tag moved or re-created onto any commit after a release step fails
  before anything is built.
- **Compare before set.** The manifest job computes the digest of the index it
  would publish (`docker buildx imagetools create --dry-run` prints its exact
  bytes) and checks both version tags in both registries before writing either
  registry. A tag that does not exist is created; a tag that already names that
  exact digest is left alone; any other digest fails the release. After each
  write, the tag must name that digest. `X.Y` and `latest` are channels and
  move as described above.
- **The digest is recorded.** The manifest job reports the published index
  digest in its summary, and the GitHub release notes name it next to the
  source commit. The release step copies it into `foundry.image`.

A rerun is idempotent only when it publishes the identical digest. Re-run the
**failed jobs** of a release run: they reuse the per-platform digests the
original build pushed, so the index is the same. Re-running **all** jobs
rebuilds the images, which are not bit-reproducible, so the comparison refuses
to publish them over tags an earlier attempt already wrote. Once the GitHub
release exists, the version is final; publish a new version instead.

### A half-published version is stranded

A release can fail after it has written a version tag to one registry but not
the other, or after both writes but before the GitHub release exists. The
version is then **half-published**: the tag that was written already names the
first attempt's images, and a version tag is immutable.

Re-running the **failed jobs** of that run can still finish it within GitHub's
30-day re-run window: the per-platform images the first build pushed stay in the
registries by digest, and a run of the manifest job rebuilds the identical
index. When both registry writes already landed and only the GitHub release
failed, the only failed job is `create-release`, which reads the manifest job's
recorded output digest rather than the digest artifacts. But GitHub allows a run
to be re-run, whole or failed jobs only, for only **30 days** after it started.
The 90-day digest artifacts outlive that window, so they help diagnose a
stranded version, not recover it. Re-running **all jobs** rebuilds the images.
Images are not bit-reproducible, so the rebuild's index digest differs from the
one the written tag already names, and compare-before-set refuses it — as it
must, because reassigning the tag is exactly what these controls prevent. Every
later attempt is refused the same way, so that version can never be finished.

There is no in-place recovery that keeps the invariant that a version tag names
one immutable digest. **Cut the next patch version (`X.Y.Z+1`) from a fresh
commit and release that.** Leave the tag the partial attempt wrote in place; do
not delete or move it.

The manifest job persists the first run's plan so a partial publish stays
diagnosable, and `release-planned-digests` is the authoritative record: it lists
the tag, the index digest, and both `platform=` digests, and a re-run of all
jobs does not overwrite it, because the new attempt stops at compare-before-set
before the record step. `release-docker-digest-*` holds whatever the latest
build pushed, so a re-run of all jobs replaces it with the rebuild's digests.
The job summary records the index digest only when the whole Docker Hub step
succeeds, and the release notes name it once the release exists. The record
survives 90 days — `retention-days: 90` in the workflow equals GitHub's maximum
for a public repository.

The workflow cannot stop someone with registry credentials from writing a tag
directly. These controls live outside the repository and are owner settings:
immutable-tag rules on Docker Hub for release version tags (never for `main`,
`X.Y`, or `latest`, which must move), a protected `release` environment with
required reviewers, and the bypass list on the tag ruleset that blocks updating
or deleting `v*` tags.

## Coverage floors

Coverage floors in `vitest.config.ts` are ratchets from a measured baseline, not
a claim that the UI is fully covered. `server/` has a separate, higher floor.
Raise the floors as coverage grows; never lower them to make a release pass.
