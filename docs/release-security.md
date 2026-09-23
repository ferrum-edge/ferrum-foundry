# Release and supply-chain gates

No container or GitHub release is published until the reusable CI workflow has
completed every launch gate:

1. the quality gate runs zero-warning lint, frontend and server type checks,
   the complete test suite with coverage floors, a production-only dependency
   audit, and a production build;
2. the gateway-contract gate seeds the same destructive payload twice against
   the Ferrum Edge image pinned by digest as `edge.image` in
   `docs/compatibility.json`, the single source CI reads it from, with
   audience and namespace enforcement enabled, then verifies the exported
   backup state plus live public, rejected-anonymous, key, basic, JWT,
   multi-auth, and response-mock traffic, and compares the UI's capability
   model with the gateway's own answers as `viewer`, `operator`, and `admin`,
   on that image and on a second copy started with `FERRUM_ADMIN_READ_ONLY`;
3. the deployment-starter and critical-journey gates bring up the checked-in
   starter with the production image and the same gateway image, and drive
   the first-success walkthrough and the browser journeys (`e2e/README.md`);
   and
4. the container gate builds and starts the release Dockerfile for both amd64
   and arm64, verifies an excluded canary cannot enter image history or layers,
   checks non-root liveness plus a protected BFF-to-gateway request, fails on
   fixed high/critical vulnerabilities, and uploads per-architecture CycloneDX
   SBOMs.

Passing these gates qualifies Foundry with that one Ferrum Edge image, not with
any other Edge build. Today `edge.image` is an interim development build; the
published Edge release a Foundry release must pair with (`edge.release`), its
requirements, the releases evaluated and rejected, what else is best-effort,
and what is not qualified are recorded in `docs/compatibility.md`. Moving the
Edge pin is a re-qualification: change `edge.image` in
`docs/compatibility.json`, and the pull request re-runs every gate above
against the new image; `scripts/supported-pairing.test.mjs` fails if the
starter, the workflow, or the launch documents still name another one.

The Docker build context is deny-by-default. Only package manifests, TypeScript
and Vite build configuration, application/server/shared source, and public
assets are sent. Files such as `.env`, Git history, documentation, local build
output, test coverage, and developer caches are outside the context.

The Dockerfile frontend, Node 24 builder, and distroless Node 24 runtime use
immutable multi-platform image digests. Main and tagged multi-architecture
publications request maximum-mode build provenance and SBOM attestations from
BuildKit. Each manifest job requires exactly two build digests, verifies their
platforms before creating any public tag, publishes and re-checks the immutable
commit or release tag, and only then promotes mutable channels. The required
runtime platforms are exactly `linux/amd64` and `linux/arm64`. The image's OCI
revision label is set to the exact Git commit being published.

Every third-party GitHub Action is pinned to a full commit SHA. Release tags
are validated as safe semantic versions and must point to a commit reachable
from `main` before any registry login or build. The `version` field in
`package.json` must equal the tag without its `v` prefix (`v1.2.3` requires
`1.2.3`), because the BFF reports that field from `/api/health/live` and
`/api/health/ready`; a mismatch fails the release before anything is built.
The same step requires `foundry.version` in `docs/compatibility.json` to equal
that version, `docs/release-notes/vX.Y.Z.md` to exist, and
`node scripts/supported-pairing.mjs release-ready` to pass: `edge.release` must
name a published Edge release and `edge.image` must be that release, so the
gates that ran for the tag qualified the release it names. The GitHub release
is published with those notes, so every release names the Edge release it was
qualified against. A
prerelease is marked as such on GitHub and never advances the stable
major/minor or `latest` image tags. A stable backport advances its major/minor
channel only when it is the newest patch in that line, and advances `latest`
only when it is the newest stable version in the repository. Per-tag workflows
remain independently queued; each manifest job waits for earlier release run
numbers to finish before promotion. Tag state is then re-fetched immediately
before image promotion and GitHub release creation, preventing a slower older
run from overwriting a newer one without canceling an intervening release.

Channel tags are explicit: every `main` publication advances `main` and an
immutable `main-<commit>` tag, while only the newest stable semantic-version
release advances `latest`. Consequently, an untagged commit or an older stable
backport can never replace the image operators receive from an unqualified
`docker pull ferrumedge/ferrum-foundry`.

Coverage floors are intentional baseline ratchets, not a claim that the UI is
fully covered. Server security code has a separate, higher aggregate floor.
Raise both floors as coverage grows; do not lower them to make a release pass.
