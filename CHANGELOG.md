# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Trusted-proxy authentication mode that turns a proxy-asserted actor, role, and namespace grants into the downstream Ferrum admin JWT (#149).
- Downstream-aware readiness at `GET /api/health/ready` plus a container `HEALTHCHECK` on `GET /api/health/live` (#149).
- Namespace registry management from the Settings page: create, rename, edit the description, and delete with a gateway-driven cascade confirmation (#115).
- Mesh trust lifecycle: create, edit, rotate, resolve revision conflicts, view publication status, and revoke, with canonical wire-shape validation (#152).
- ACME certificate get, import, and replace APIs and UI, with explicit import-versus-replace semantics and confirmation before deletion (#152).
- Per-instance restore and API-spec upload capacity limiting through `FERRUM_MAX_LARGE_UPLOADS` (#149).
- `FERRUM_BIND_ADDRESS` to select the interface the BFF listens on, defaulting to `0.0.0.0`.
- `FERRUM_SHUTDOWN_TIMEOUT` to bound how long `SIGTERM` and `SIGINT` wait for in-flight requests.
- Production deployment guide, security policy, and a complete environment-variable reference.

### Changed

- Proxy and upstream edits preserve every canonical field across full replacement, with explicit inherit and clear controls (#150).
- Consumer credential builders match the canonical Key, Basic, JWT, and HMAC schemas and keep secret bytes exact (#150).
- List, search, and relationship reads use one active query over complete collections instead of double queries and fixed caps (#151).
- Restore's API-spec deletion override became a typed, namespace-pinned, phrase-gated second confirmation with exactly one retry (#151).
- Gateway response metadata is retained so cached reads are flagged and committed-but-not-live writes are distinguished from pre-commit `503`s (#151).
- Admin JWT signing is centralized so the BFF and the demo seeder share one role, audience, and namespace claim contract (#155).
- The container base and CI runtime move to Node.js 24 LTS; Node.js 22 remains the minimum supported local version.
- Dependencies refreshed across frontend, server, and tooling, including adoption of ESLint 10.
- Trusted-proxy CSRF tokens are stateless, so replicas no longer depend on shared server-side grant state.
- Repository agent skill setup mirrored from Ferrum Edge for local review workflows (#154).

### Fixed

- Deep links and refreshes on nested routes such as `/proxies/<id>` no longer break authentication, and unknown routes render a styled not-found page instead of bare text.
- Proxy-group membership writes use complete pagination, preflight validation, serialized version checks, and compensating rollback with precise manual recovery targets (#150).
- Consumer and proxy relationships resolve from enabled global, direct, and associated group plugins with canonical ACL precedence (#150).
- Restore rollback outcomes are surfaced instead of being reported as plain success (#151).
- Apply-status monitoring polls without replaying the original mutation, and a newer mutation cancels a superseded monitor (#151).
- Renaming or deleting a namespace no longer pops a spurious `404` over the success toast (#115).
- Stale correlation-ID and rate-limit plugin defaults corrected against a real gateway (#155).
- The README no longer claims virtual scrolling that the tables do not use (#151).

### Security

- Production startup fails closed unless trusted-proxy authentication is configured; the static token flow is development-only behind an explicit unsafe override (#149).
- Browser bearer authentication replaced with an HttpOnly, SameSite server-managed session plus CSRF protection, so no reusable administrator credential reaches browser storage (#149).
- Trusted-proxy identity assertions must carry the `X-Ferrum-Auth-Secret` proof header, compared in constant time before any body parsing (#149).
- Admin JWTs are minted per principal with complete role, namespace, and audience claims and are cached by every signing input (#149).
- Encoded and dot-segment proxy-route boundary bypasses are rejected over a real HTTP socket (#149).
- CA bundles must resolve inside an approved root, and contained Kubernetes-style projections reload safely after rotation (#149).
- Gateway DNS results are checked against a private and special-purpose network policy, with `FERRUM_ADMIN_ALLOWED_CIDRS` as the explicit opt-in (#149).
- Runtime settings are immutable by default and accept only allowlisted, validated fields when enabled (#149).
- Strict browser security headers, a self-only content security policy, and suppressed production source maps (#149).
- Private JWK material is rejected in trust forms, and trust and ACME key buffers are never written to browser storage and are cleared on close (#152).
- Publication is gated on zero-warning lint, tests, coverage floors, a production dependency audit, a pinned real-gateway contract, exact-image smoke tests, vulnerability scanning, SBOM generation, and provenance (#155).
- Deny-by-default Docker build context, digest-pinned multi-architecture bases, and full commit SHA pins for every third-party GitHub Action (#155).
- Release channels are monotonic: tags are validated and ancestry-checked before registry access, prereleases never advance stable tags, and promotion runs through a fail-closed FIFO queue (#155).
- Scheduled live branch deletion replaced with dry-run planning plus a separately approved, exact-SHA-revalidated deletion path (#155).
