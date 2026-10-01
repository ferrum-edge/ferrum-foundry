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
other build. Every gateway-backed gate runs against the published Ferrum Edge
v0.9.10 release in `edge.image`, including the MCP security fixes in
ferrum-edge#5954. Foundry v0.4.0 pairs with v0.9.10; the previous Foundry
v0.3.0 release paired with v0.9.8.
Requirements, best-effort and unqualified setups, and rejected images are in
[the compatibility record](compatibility.md).

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

The runtime is temporarily `node:24-trixie-slim` (Debian 13) instead of
`gcr.io/distroless/nodejs24-debian13:nonroot`, because the pinned distroless
image ships a `libssl3t64` with fixable high-severity findings (CVE-2026-75804,
CVE-2026-84782) that upstream has not rebuilt. This is not a distroless image:
the Node package managers (npm, npx, corepack, yarn) are removed, but a shell
and apt/dpkg remain until #504. The runtime runs as UID/GID `65532:65532`, has
Node as its entrypoint, and exposes Node at the distroless path
`/nodejs/bin/node`. Returning to distroless is tracked in
[#504](https://github.com/ferrum-edge/ferrum-foundry/issues/504).

While this workaround is in place, the base digests alone do not identify the
exact image inputs. The runtime stage installs `libssl3t64` and
`openssl-provider-legacy` pinned to `3.5.7-1~deb13u3`, and `libpcre2-8-0`
pinned to `10.46-1~deb13u3`, from the live Debian security feed at build
time, so the build fails if either exact version is no longer offered, and
each publish or release rebuild fetches the packages again. The SBOM attached
to each published image records the package versions it actually contains.

Every third-party GitHub Action is pinned to a full commit SHA.

## Publishing

Pushes to `main` and release tags publish multi-architecture images with
BuildKit provenance (`mode=max`) and SBOM attestations. Each manifest job
requires exactly two per-platform digests, checks that they are `linux/amd64`
and `linux/arm64`, publishes and re-checks the immutable tag, and only then
moves channel tags.

| Trigger | Immutable tag | Channel tags |
| --- | --- | --- |
| Push to `main` | `main-<commit>` | `main` |
| Release tag `vX.Y.Z` | `vX.Y.Z` | `X.Y.Z`; `X.Y` if it is the newest patch in that line; `latest` if it is the newest stable version |

A prerelease tag (`vX.Y.Z-suffix`) is marked as a prerelease on GitHub and never
moves `X.Y` or `latest`. An untagged commit or an older stable backport can
therefore never replace what `docker pull ferrumedge/ferrum-foundry` returns.

Before any registry login or build, the release workflow requires that:

- the tag is a safe semantic version and points to a commit reachable from
  `main`;
- `package.json` `version` equals the tag without its `v` (`v1.2.3` needs
  `1.2.3`), because the BFF reports it from `/api/health/live` and
  `/api/health/ready`;
- `foundry.version` in `docs/compatibility.json` equals that version;
- `docs/release-notes/vX.Y.Z.md` exists and is not empty;
- `node scripts/supported-pairing.mjs release-ready` passes: `edge.release` names
  a published Edge release and `edge.image` is that release.

The GitHub release is published with those notes. Release runs for different
tags are queued independently: each manifest job waits for earlier release runs
to finish, and tags are re-fetched just before image promotion and GitHub
release creation, so a slower older run cannot overwrite a newer one.

## Coverage floors

Coverage floors in `vitest.config.ts` are ratchets from a measured baseline, not
a claim that the UI is fully covered. `server/` has a separate, higher floor.
Raise the floors as coverage grows; never lower them to make a release pass.
