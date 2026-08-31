# Release and supply-chain gates

No container or GitHub release is published until the reusable CI workflow has
completed all three launch gates:

1. the quality gate runs zero-warning lint, frontend and server type checks,
   the complete test suite with coverage floors, a production-only dependency
   audit, and a production build;
2. the gateway-contract gate seeds the same destructive payload twice against
   the immutable Ferrum Edge image digest
   `sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`,
   with audience and namespace enforcement enabled, then verifies the exported
   backup state plus live public, rejected-anonymous, key, basic, JWT,
   multi-auth, and response-mock traffic; and
3. the container gate builds and starts the release Dockerfile for both amd64
   and arm64, verifies an excluded canary cannot enter image history or layers,
   checks non-root liveness plus a protected BFF-to-gateway request, fails on
   fixed high/critical vulnerabilities, and uploads per-architecture CycloneDX
   SBOMs.

The Docker build context is deny-by-default. Only package manifests, TypeScript
and Vite build configuration, application/server/shared source, and public
assets are sent. Files such as `.env`, Git history, documentation, local build
output, test coverage, and developer caches are outside the context.

The Dockerfile frontend, Node 22 builder, and distroless Node 22 runtime use
immutable multi-platform image digests. Main and tagged multi-architecture
publications request maximum-mode build provenance and SBOM attestations from
BuildKit. Each manifest job requires exactly two build digests, verifies their
platforms before creating any public tag, publishes and re-checks the immutable
commit or release tag, and only then promotes mutable channels. The required
runtime platforms are exactly `linux/amd64` and `linux/arm64`. The image's OCI
revision label is set to the exact Git commit being published.

Every third-party GitHub Action is pinned to a full commit SHA. Release tags are
validated as safe semantic versions and must point to a commit reachable from
`main` before any registry login or build. A prerelease is marked as such on
GitHub and never advances the stable major/minor or `latest` image tags. A
stable backport advances its major/minor channel only when it is the newest
patch in that line, and advances `latest` only when it is the newest stable
version in the repository. Release workflows serialize channel mutation across
tags and re-fetch tag state immediately before image promotion and GitHub
release creation, preventing a slower older run from overwriting a newer one.

Channel tags are explicit: every `main` publication advances `main` and an
immutable `main-<commit>` tag, while only the newest stable semantic-version
release advances `latest`. Consequently, an untagged commit or an older stable
backport can never replace the image operators receive from an unqualified
`docker pull ferrumedge/ferrum-foundry`.

Coverage floors are intentional baseline ratchets, not a claim that the UI is
fully covered. Server security code has a separate, higher aggregate floor.
Raise both floors as coverage grows; do not lower them to make a release pass.
