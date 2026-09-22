# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Ordinary navigation no longer downloads whole namespace collections. Opening the proxy list fetches one page of rows and names their upstreams from one catalog page (or, in a namespace larger than that page, one read per visible row); opening a proxy editor issues exactly one request, with plugin, consumer, and upstream reads deferred to the tab that needs them. The list's effective-plugin column stops at a budget and reports the count as unavailable at that size rather than a number derived from a partial scan, while the policy views that produce authorization conclusions still traverse completely or report unknown. Collection traversals now carry the query's abort signal, so a namespace switch abandons them instead of paying for pages nobody will read. Measured against a 50,000-record fixture, opening the proxy list went from 200 requests and 11.5 MB to 2–22 requests and under 75 KB. Server-side search still needs an upstream contract and is documented as such. See `docs/data-loading.md` (#382).
- Local gateway setup docs pin `ferrumedge/ferrum-edge:v0.9.5` instead of the stale `latest` tag and note that release images are chosen from upstream releases (#361).

### Added

- A maintained deployment starter (`deploy/starter/`) and a first-success walkthrough (`docs/getting-started.md`): one Compose stack for the documented production topology, and a `demo` profile that brings up a disposable gateway, backend, and stub identity provider so a new operator can go from nothing to an authenticated request through the real data plane. The group-to-role policy and the four identity headers are shared includes, so the demo exercises the production authorization path rather than a look-alike. `scripts/starter-preflight.mjs` reports configuration, gateway reachability, TLS trust, signing-key/audience compatibility, namespace grants, and the trust boundary, distinguishing an unknown from a pass; `scripts/starter-journey.mjs` executes the walkthrough and asserts anonymous denial, unmapped-user denial, forged-header stripping, role and namespace grants, and authenticated data-plane success. Both run in CI against the production image and the pinned gateway, and publication is gated on them (#384).
- Guided configuration for `key_auth`, `rate_limiting`, `cors`, and `prometheus_metrics`: labelled controls with the schema's own descriptions, enums, bounds, and patterns, inline accessible validation before submission, and explicitly unconfirmed notes for prerequisites only the deployment can satisfy. The advanced JSON editor remains one click away and stays the complete surface. Edits are lossless — unmodelled keys, key order, and the difference between an absent field, an explicit `null`, and an empty value all survive a JSON → guided → JSON round trip — and a configuration the field set cannot represent (a multi-rule rate-limit policy, Istio `StringMatch` CORS origins, an Istio-projected CORS policy) falls back to raw JSON with its reason rather than being rewritten. Field descriptors are transcribed from named `openapi.yaml` components with each component's SHA-256 pinned; `npm run check:plugin-schemas` re-fetches the spec on every pull request and fails on drift. See `docs/plugin-schemas.md` (#383).
- TLS → Validate exposes the full `TlsValidateRequest`: CRL PEM, `allow_expired`, and `cert_expiry_warning_days` with inline validation, and every TLS textarea, inline error, and destructive record button now has an accessible name (#362, #363).
- Vite's dev-server port and `/api` proxy target are configurable through `VITE_DEV_PORT`, `PORT`, and `VITE_BFF_URL`, so Foundry can run alongside another Vite app such as Nexus without editing `vite.config.ts` (#327).
- `VITE_DEV_HOST` selects Vite's listen address (`localhost` by default; `127.0.0.1` forces IPv4 loopback). Dev docs use `localhost` for the SPA origin and BFF cookie host so dual-stack `localhost` vs `127.0.0.1` 401s are not the default path (#344).
- A client-side capability model derived from the session role and the gateway's reported mode. Surfaces a session cannot write — a `viewer` on any gateway, any role on a `file`/`dp`/`mesh`/`node_agent` gateway or one reporting `admin_writes_enabled: false` — render read-only with the reason visible before anything is edited, instead of accepting a full form and failing with `403`. Each surface names the upstream write gate it mirrors, so managed TLS/ACME material is correctly refused in a read-only mode while staying off the config-database failover gate, and rotate/validate stay available. A read-only form still shows everything the editable one does: collapsible sections are forced open and Cancel stays usable. Server-side authorization is unchanged, and an unread health snapshot never downgrades a surface. `MOCK_GATEWAY_MODE` reproduces a read-only admin API against `scripts/mock-admin-gateway.mjs` (#359).

### Fixed

- Full-replacement saves from a detail editor no longer silently revert another session's accepted change. The editor captures the content it was seeded with, the API layer re-reads and compares it immediately before the `PUT`, and a mismatch refuses the write without sending anything — including a change made by a second Foundry deployment, the seeding scripts, or any direct admin-API client. The refused draft is preserved and shown against the gateway's current content with credential-shaped values redacted; there is no "save anyway" and nothing is ever resent automatically. The gateway has no conditional-write precondition (`If-Match` is ignored), so this narrows the race to one round trip rather than closing it — `scripts/concurrent-edit-contract.mjs` records that behavior against the pinned image on every pull request and fails if Edge starts enforcing `412`. See `docs/concurrent-edits.md` (#381).
- A proxy-scoped plugin created or retargeted through the UI is now verified to be attached to its proxy, and attached when the gateway did not do it. `openapi.yaml` states that a proxy-scoped plugin "applies only when the target proxy lists it in `plugins` — `proxy_id` alone never attaches it" and that the gateway appends the association in the same transaction; the pinned gateway image answers `201` without appending it. The visible consequence was attaching key authentication to a route, being told it worked, and the route continuing to serve anonymous traffic. The check is a read-back, so a gateway that performs the side effect is never written to twice, and a reconciliation that fails is reported (and the unattached plugin removed) rather than leaving something that looks like a configured policy.
- The client-side capability model observes `FERRUM_ADMIN_READ_ONLY` on `database`/`cp` gateways (`admin_writes_enabled: false` with health `status` other than `degraded`), denies configuration export on `node_agent`, and presents disabled fieldset descendants and denied `WriteAction` buttons with the same greyed appearance as controls that pass `disabled` directly (#373).
- Cluster backend capabilities on a control plane explain that probes belong to a data plane instead of showing a permanent read error and Re-probe All (#364).
- Overload protection shows disabled file-descriptor shedding and unconfigured request limits instead of a misleading `current / 0` ratio (#360).
- Keep proxy, consumer, upstream, and plugin editors mounted through failed background reads, preserving unsaved fields and group membership with a retry notice (#299).
- Distinguish unknown reads from empty or current data across policy relationships, SPIFFE trust, federation, remote clusters, waypoints, dashboard, audit, and API specs. Hide unavailable collection actions and add dashboard refresh controls and observation times (#298).
- The active namespace is resolved against the principal's grants during render, so the first request after a load or an identity-grant change no longer carries an ungranted namespace and is no longer refused `403 Namespace access denied` behind a modal error dialog (#296).
- A restore whose outcome Foundry could not observe — a response-phase BFF timeout, a `502 FERRUM_BFF_UPSTREAM_FAILURE`, a client timeout, or a dropped connection — is reported as an unknown outcome that clears the pinned backup and refreshes cached reads, instead of a generic failure toast that left the destructive confirmation armed for a one-click replay. An upload-phase timeout still proves the restore did not run and stays retryable (#295).

### Security

- Request bodies proxied to the gateway are bounded by an absolute upload deadline (`FERRUM_UPLOAD_TIMEOUT`) and a global in-flight upload cap (`FERRUM_MAX_ACTIVE_UPLOADS`) in addition to the idle write timeout, so a slowly progressing upload can no longer hold sockets, upstream requests, or upload permits indefinitely.

## [0.1.0] - 2026-09-03

First public release of Ferrum Foundry.

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
- The BFF trusts forwarded client addresses from exactly the directly connected identity proxy through an explicit predicate, after Fastify 5.12.1 stopped honoring the numeric hop-count form.
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

[Unreleased]: https://github.com/ferrum-edge/ferrum-foundry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0
