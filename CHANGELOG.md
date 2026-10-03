# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The OIDC Relying Party template no longer includes a public session encryption
  key. Foundry blocks enabling it until an operator supplies a unique secret,
  and the plugin defaults contract supplies a generated key when checking the
  remaining template fields (GHSA-hjw6-685j-p5hw). Deployments that enabled
  OIDC from this template must rotate `session.encryption_secret` now. Do not
  carry the old public key in `session.encryption_secret_previous`.
- GHSA-27j6-vr5h-8p6v: with `NODE_ENV=production`, the BFF refuses to start
  when `FERRUM_ADMIN_URL` or a `FERRUM_ADMIN_ALLOWED_ORIGINS` entry is a
  plaintext `http://` origin on a host other than loopback (exact `localhost`,
  `127.0.0.0/8`, or `::1`), and refuses such a runtime `adminUrl` change with
  `400 FERRUM_BFF_INVALID_SETTINGS`, because every admin request carries a
  signed bearer token. `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` is the explicit
  exception for a disposable stack; the starter's demo bootstrap, the e2e
  overlay, and the CI container gate set it for their in-network gateways. The
  seeder and the helpers that share its configuration (verify, route smoke,
  contract smoke, capability parity) refuse a remote plaintext admin origin
  with no exception, and the starter preflight no longer mints or sends its
  credentialed probe to one; it reports a remote plaintext admin URL as a
  failure, or as unknown under the override. Breaking: a production
  deployment using remote `http://` must move to `https` or set the override.
- GHSA-74cv-h27v-866v: startup refuses trusted-proxy identity header names
  that collide. Compared case-insensitively, the user, role, and namespaces
  headers must differ from each other and from the fixed
  `X-Ferrum-Auth-Secret`, and none may be a header HTTP or the BFF already
  uses (hop-by-hop and credential headers, request framing and forwarding
  headers, `X-CSRF-Token`, `X-Ferrum-Namespace`, `X-Foundry-Gateway-Target`).
- GHSA-rw8r-hrr2-vpc2: the release workflow never reassigns a release version
  tag. The tag must name the commit the run builds, checked at the start and
  again before the registries are written and before the GitHub release is
  created. `supported-pairing.mjs release-ready` refuses a record that is no
  longer the unreleased `candidate`, so a tag moved onto a commit after the
  release step cannot republish the version. Before any build, the workflow
  refuses a version that already has a GitHub release, or whose `vX.Y.Z` or
  `X.Y.Z` tag on Docker Hub or GHCR carries another commit's
  `org.opencontainers.image.revision` (`scripts/release-image-identity.mjs`).
  The manifest job computes the index digest it would publish and compares
  both version tags in both registries before writing either: an absent tag is
  created, a tag already naming that digest is left alone (an idempotent
  rerun), and any other digest fails the release. The published digest is
  recorded in the job summary and the GitHub release notes.

### Changed

- The runtime image is distroless again (#504):
  `gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by index digest, now
  that upstream ships the fixed `libssl3t64` 3.5.7-1~deb13u3. The temporary
  `node:24-trixie-slim` runtime, its build-time OpenSSL and `libpcre2-8-0`
  package pins, and its shell and apt/dpkg are gone. The image still runs as
  `65532:65532` with `/nodejs/bin/node` as its entrypoint and in its
  HEALTHCHECK, and the starter test again requires the distroless base.

### Fixed

- Encode dynamic Admin API path segments across resource endpoints and reject
  empty or dot-segment identifiers, preventing decoded route identifiers from
  retargeting requests. Addresses GHSA-64c9-hw76-jqmh.

## [0.4.0] - 2026-10-01

Pairs with the published **Ferrum Edge v0.9.10** release,
`ferrumedge/ferrum-edge@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc`.
See `docs/compatibility.md` and `docs/release-notes/v0.4.0.md`.

### Added

- Proxy pages gain an MCP Tools tab for `mcp_gateway` proxies (#505). It reads
  Ferrum Edge v0.9.9's cached tool catalog (`GET /proxies/{id}/mcp/tools`) and
  lists every tool with its public name, source (an upstream MCP server, or the
  OpenAPI operation that generated it), description, annotations, configured
  and effective policy, whether it is listed and callable, and its
  `allowed_groups` / `denied_groups` grants, together with each instance's
  catalog state, servers, and fixed-text refresh errors. The catalog is
  node-local: on a control plane, or a node that does not serve the proxy,
  Foundry shows `not_served` with the reason and where the catalog lives
  instead of an empty list, and still lists the stored policy.
- Inline per-tool policy editing: allow, deny, hide from discovery, or remove
  the entry, plus allowed and denied groups. A save replaces one
  `policy.tools` entry through the conditional-write path (`If-Match` from the
  read every other field is rebuilt from), omits `labels` so `provisioned-by`
  survives, says that removing an entry leaves a tool hidden from new sessions
  until configured under Edge's default `discovery.on_new_tool`, checks Edge's
  grant rules first, and is refused before sending when the session's read
  masks a value. A saved change is marked "not yet live on this node" until
  the catalog reports it.
- An AI governance summary on the same tab: whether `ai_tool_governor`,
  `ai_prompt_shield`, `ai_transcript_audit`, and a `rate_limiting` tool-call
  limit run on the proxy, whether each is configured for MCP `tools/call`
  (a limit whose `mcp_tool_calls.endpoint_path` is no gateway endpoint counts
  nothing here; one whose `tools` names a subset, or that leaves another
  gateway endpoint uncounted, is marked partial), and a warning when an
  agent-facing endpoint has none.
- The mock admin gateway serves `GET /proxies/{id}/mcp/tools` with the v0.9.9
  shape and node-local states, has an `mcp_gateway` demo proxy, and refuses
  the `policy.tools` shapes Edge refuses.

### Changed

- Foundry v0.4.0 pairs with the published Ferrum Edge v0.9.10 multi-architecture
  release, qualified in [#524](https://github.com/ferrum-edge/ferrum-foundry/pull/524).
  Edge v0.9.10 contains
  ferrum-edge#5954: `mcp_gateway` and `ai_prompt_shield` refuse non-UTF-8
  charset inputs and fail closed on uninspectable or over-nested JSON-RPC
  batches (GHSA-4f9m-cfqg-fhx9, GHSA-f2jp-59r9-fp64). No admin API or
  plugin sensitivity rules changed from v0.9.9.

- Qualify the published Ferrum Edge v0.9.9 release for the next Foundry pairing
  (#512). Gateway-backed CI, the deployment starter, and local-run instructions
  use its multi-architecture image digest. Foundry v0.3.0 remains the last
  released Foundry version. Edge v0.9.9 adds a viewer-readable MCP catalog
  route, which the capability parity contract probes and requires to answer
  with the handler's own `Proxy not found`; proxy support for semicolon path
  parameters, which the proxy form edits for HTTP proxies only; and a `400` for
  writes that echo masked secret placeholders, which the Pinned Gateway
  Contract checks with an `operator` read-modify-write of a plugin
  configuration whose endpoint path is masked.

- Plugin configuration and upstream editors no longer treat a masked secret as
  a value that survives a save. An `operator` read shows plugin secrets,
  credential-bearing endpoint URL components, and an upstream's Consul token as
  placeholders (`[REDACTED]`, `redacted@`, `/[REDACTED_PATH]`,
  `?[REDACTED_QUERY]`, `#[REDACTED_FRAGMENT]`), which Edge v0.9.9 refuses to
  accept back (ferrum-edge#5925). Each such field is now marked "Hidden from
  your role", and Save stays blocked until it is re-entered or cleared with its
  Clear action; clearing omits the field, which deletes the stored secret
  because `PUT` is a full replace. Foundry's placeholder check mirrors Edge's
  `is_redaction_placeholder` exactly, and it blocks only where Edge refuses:
  never for an `admin`, whose reads are raw, and for other roles only at the
  fields the read masks, found by replaying Edge's schema rules, name floor,
  and URL-userinfo sweep. A placeholder-shaped value anywhere else (such as
  `ai_prompt_shield`'s `redaction_placeholder`) gets a warning and is saved as
  written; a plugin Foundry has no rules for keeps every placeholder blocked.

- Pin Ferrum Contracts `contracts-edge-0.9.9` for the plugin catalog and
  `provisioned-by` vocabulary, with CI checks for vendored file integrity and
  Foundry's local catalog and provisioning markers. The contract test also ties
  the pin to the Ferrum Edge release qualified in `docs/compatibility.json`, and
  the README names ferrum-contracts as the org's central contract store.

### Fixed

- The plugin-sensitivity drift check now reports an equal-length rule pair that
  differs only by a wildcard (`x.*` against `x.b`), whose order changes which
  masked-placeholder sites Edge handles first, instead of skipping it as a
  duplicate. A pair is a duplicate only when both paths match segment for
  segment after normalization and the sensitivity is equal (#515).

- TLS inventory, managed material, ACME, and event reads now show an
  unavailable or stale state with the read error instead of reporting an empty
  store when the gateway read fails (#511). Managed certificate, OCSP, and
  JWKS material validation errors from Ferrum Edge v0.9.9 now attach to their
  corresponding form fields (#517).
- The capability-parity contract no longer misclassifies a `file`/`dp` gateway
  as admitting `POST /restore`. In those modes Edge has no configuration
  database, so `handle_restore` calls `require_db` before its write gate and
  answers the documented `503 {"error":"No database"}` rather than the
  read-only `403`. The contract accepts that exact typed `503` as an expected
  read-only outcome under a read-only expectation, never describes a `503` as
  admitted, and still fails on a `2xx` the model treats as read-only or on a
  `503` of any other shape (#516).

- Settings namespace selection now reports a failed registry read as
  unavailable with a retry action. Manual namespace entry remains available as
  a clearly labeled fallback during an outage, while a successfully empty
  registry keeps the manual-entry flow.
- An `operator` can save plugin configurations and upstreams against Ferrum
  Edge v0.9.9: the editors no longer send the placeholders their masked read
  returned, which Edge refuses with `400`. When Edge does refuse a save, the
  page lists the JSON pointers it names, once. A non-admin targets save on an
  upstream whose Consul token is masked is refused before anything is sent,
  with the reason, instead of resending the placeholder. A failed membership
  change no longer tries to restore a plugin configuration that was read
  masked for the session's role; the recovery report names the fields that
  need manual recovery.

### Security

- Upgrade the runtime image's `libpcre2-8-0` to `10.46-1~deb13u3` (pinned, from
  the Debian security feed) for CVE-2026-103111, an out-of-bounds write via a
  crafted regular expression (#513). The pinned `node:24-trixie-slim` base still
  carries `10.46-1~deb13u2`.
- Update production dependencies `brace-expansion` and `fast-uri` to versions
  that fix reported denial-of-service and URI parsing vulnerabilities.
- Temporarily run the container on `node:24-trixie-slim` (digest-pinned) instead of `gcr.io/distroless/nodejs24-debian13:nonroot`, whose pinned `libssl3t64` carries fixable high-severity findings (CVE-2026-75804, CVE-2026-84782) that upstream has not rebuilt. This is not a distroless image: Node package managers (npm, npx, corepack, yarn, whose bundled dependencies carry their own findings) are removed, but a shell and apt/dpkg remain until #504. The runtime stage upgrades only `libssl3t64` and `openssl-provider-legacy`, pinned to `3.5.7-1~deb13u3` (and, since the entry above, `libpcre2-8-0` pinned to `10.46-1~deb13u3`) from the live Debian security feed (the build fails if a pinned version is gone, and each publish or release rebuild fetches it again). It runs as the numeric user `65532:65532`, so Kubernetes `runAsNonRoot` can verify it, and keeps Node as the entrypoint at the distroless path `/nodejs/bin/node`, so the starter's demo backend works with this image and with already-published distroless images. The Container Gate now also requires a numeric runtime user and proves the process is not root and that there are no Node package managers in the image. Return to distroless: #504.
- GHSA-gg76-x87w-mj4v: starter preflight and walkthrough helpers now send the trusted-proxy proof over HTTPS or HTTP only to exact `localhost` or verified IPv4/IPv6 loopback literals. DNS hostnames are never treated as loopback based on their text (#507).

## [0.3.0] - 2026-09-27

Pairs with the published **Ferrum Edge v0.9.8** release,
`ferrumedge/ferrum-edge@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385`.
Static authentication mode now requires `FERRUM_JWT_NAMESPACES` (see "Breaking").
See `docs/compatibility.md` and `docs/release-notes/v0.3.0.md`.

### Breaking

- Static authentication mode now refuses to start when `FERRUM_JWT_NAMESPACES` is unset, and the error names both options: exact namespace names, or `*` for every namespace. An unset variable previously granted the static principal every namespace without saying so. To keep that behavior, set `FERRUM_JWT_NAMESPACES=*`: the static principal stays unrestricted and its gateway JWTs carry no `ns` claim. `trusted-proxy` mode is unchanged: there the variable only scopes the readiness probe and may stay unset. See `docs/release-notes/v0.3.0.md` → "Upgrading from v0.2.0" (#462).

### Changed

- Foundry v0.3.0 pairs with the published Ferrum Edge v0.9.8 release (commit `e27f2109216352c3fe9e67a7014611f3f66daa91`; `linux/amd64` `sha256:0e629633ad55368002c415bbf76d4c91f3741519a33dd310045531d791d9a592`, `linux/arm64` `sha256:1e900bd537814fdc864ee1830bbd7a1e1f2785074a5da088a3d9cdd738b532f9`). It is recorded as `edge.release` and is `edge.image`, so CI, the deployment starter, and the local-run instructions run it instead of v0.9.7. Edge's admin API source, plugin configuration projection, and plugin scope merge are unchanged from v0.9.7, so conditional writes (ferrum-edge#5661) and the `proxy_id` filter (ferrum-edge#5726) behave as before; `PLUGIN_SENSITIVITY_SOURCE` records the re-read at the v0.9.8 commit. `package.json` and `foundry.version` are `0.3.0`, and the release notes are `docs/release-notes/v0.3.0.md`.
- UI polish pass. Every page opens with the same title bar, whose actions wrap under the description on a phone, and create and detail pages link back to their list. The dashboard shows Foundry connection and gateway health side by side, keeps its refresh controls in the title bar, and uses the sidebar's icon for each resource. Resource tables sit flush with their cards with aligned cells and one em dash for an empty value; a stream proxy lists its listen port, a plugin priority override is a plain number marked "override", and pagination stays on one line on a phone. Dates share one format, machine keys read as labels ("Half-open", "mTLS credentials", sentence-case health fields), buttons beside inputs match their height, the Health page uses two columns on wide screens, environment-configured Settings are shown read-only, and a small brand mark replaces the 515 KB illustration in the sidebar, favicon, phone header, and sign-in page.

### Fixed

- Metrics: the dashboard's requests per second and status-code rates are no longer computed from two different gateways' counters after the BFF is re-pointed. The stored request sample now names the gateway target it was observed on; a sample from another target, or one naming none, is ignored, and the first reading from a new target replaces it, so the rate stays unavailable until two readings from the same gateway exist — including after switching back to an earlier target. A reload that binds the same target still bridges with a recent sample (#476).
- Saving an upstream no longer rewrites a subset selector whose label key contains `=` or whose value contains `,`. Subset labels are now edited as separate key and value fields instead of one `key=value, …` string, and a selector the operator did not touch is written back exactly as it was read. An edited label is sent exactly as entered; a label with no key, a duplicate key, or a subset left with no labels is refused on the row instead of being dropped (#479).
- Effective policy now excludes an attached `proxy_group` plugin configuration if it carries `proxy_id`. This matches Ferrum Edge v0.9.7's full plugin composition check, which accepts an associated group configuration only when `proxy_id` is absent; otherwise Foundry could report policy that the gateway does not apply (#472).
- An open upstream target form no longer lets a background refresh advance its write guard past the draft. Opening the add or edit form captures the target list on screen and the guard built from it; the saved list is computed from that capture, so a concurrent change to the targets that a refetch brought into the page is refused with the original/current/proposed comparison and the draft kept, instead of being overwritten by a save the guard approved against the newer list. Settings changes picked up by the same refetch still compose, and "Discard my draft and reload" from a targets refusal closes only the target form. The open form and its captured list are now one piece of state, so Update Target can no longer return without saving or saying why; and after a removal that committed but is not yet live, an open form adopts the fresh read only when it holds exactly the list the removal wrote, instead of refusing every later save against the operator's own removal (#445).
- The upstream target editors are bound to the target they edit rather than to a row position. Removing an earlier target, or a refresh that inserts one, no longer moves the open editor onto another row or discards its draft, on both the Targets tab and the Configuration form (#448).
- A restore no longer leaves pre-restore detail entries behind to seed editors. It retires the restored namespace's proxy, upstream, consumer, plugin configuration, and API spec detail caches, and its inactive lists of those kinds (a proxy-group plugin's membership is seeded from the proxy list) — after a success, a committed-but-not-live answer, an unobserved outcome, or any server failure whose answer does not prove the namespace unchanged — so reopening a restored resource loads and shows what the gateway now holds (#446).
- Saving an unrelated upstream change no longer adds `SameSite=Lax` to a sticky-hash cookie stored without a SameSite attribute. A `null` or omitted attribute is kept as it was read, the SameSite selector offers "Not set", and Lax is the default only for a cookie configuration the form creates (#449).
- Upstream target edit and remove buttons, target tag remove buttons, and subset remove buttons now have accessible names that identify the target, tag, or subset they act on; their icons are hidden from assistive technology (#455).
- A consumer credential write the gateway answered as committed but not yet live no longer leaves the credential form armed. Appending a key, JWT, or HMAC secret, replacing basic credentials, and deleting a credential now complete as the durable writes they are: the secret is shown once, the draft and its submit action are cleared, the consumer is re-read, and the card states that the change is committed but not yet proven live, so a second click can no longer append the same secret again. A credential add whose answer was lost keeps its draft but cannot be resubmitted until the consumer has been re-read, and an indexed delete whose answer was lost requires a fresh selection. Neither outcome retains the secret-bearing request in the mutation's error (#451).
- A set `FERRUM_JWT_NAMESPACES` that names no namespace — empty, whitespace only, or commas only — previously loaded as if the variable were unset, leaving the static principal unrestricted and its gateway JWTs without an `ns` claim. It is now a startup error in either authentication mode, as are an invalid name and `*` combined with names; `*` alone is the explicit spelling for every namespace. Empty entries are dropped when at least one entry remains, as before, so `tenant-a,,tenant-b` means `tenant-a,tenant-b` and `*,` means `*`. Leaving the variable unset in static mode is now a startup error as well; see "Breaking". Runtime settings apply the same rules: `jwtNamespaces: []` is refused with `400 FERRUM_BFF_INVALID_SETTINGS` instead of clearing the restriction, every namespace is granted only by `["*"]`, and a session holding namespace grants can narrow the defaults but not widen them (`403 FERRUM_BFF_NAMESPACE_GRANT_EXCEEDED`, logged as a warning with the actor and requested grants). `GET /api/settings` now always includes `jwtNamespaces`, reporting an unrestricted static principal as `["*"]` (in `trusted-proxy` mode this describes only the readiness probe's scope). The Settings form refuses an empty or mixed grant list before saving, leaves untouched grants out of a save so a session narrower than the defaults can still change other settings, and shows a refused widening on the field. In `trusted-proxy` mode, an `X-Ferrum-Namespaces` header that is present but empty or whitespace only was read as the omitted header and made an admin unrestricted; it is now rejected with `401` for every role, while an admin that omits the header remains unrestricted. nginx drops empty `proxy_set_header` values, so the deployment starter is unaffected. See `docs/deployment.md` → "Downstream JWT claims" (#460).
- The consumer credential card reports a credential add whose answer was lost more honestly and keeps it locked correctly. Because secrets are listed redacted and basic credentials are not listed, the re-read can only say a key, JWT, or HMAC credential was *likely* stored (the count went up) or likely not; for a basic add it says presence cannot be observed and points to "Replace basic credentials", which is safe to repeat but revokes every existing basic password. The lock is now judged against the consumer revision recorded when the lost answer arrived, so a refetch that landed during the write can no longer re-arm the form after the write's own re-read fails. The "outcome unknown" status line now survives Cancel and reopening the form until a later add, replacement, or delete of all basic credentials completes; deleting one listed credential keeps it and, if that credential was listed before the add, discounts it from the count comparison. A double submit sends one write. A rejected add no longer surfaces or retains a secret the gateway echoed: every submitted value is replaced by `[REDACTED]` throughout the gateway's error body — raw, JSON-escaped, and with surrounding whitespace trimmed — before any field is trimmed or shortened for display, so neither a long secret nor a whitespace-padded one survives in part, and the global error popup is not shown for it (#466).
- Follow-ups to the upstream target editor and namespace-grant changes (#464). An open target edit form is keyed by its own opening rather than by its target's `host:port` occurrence, so removing an earlier target with the same address no longer remounts the form and discards the typing, and after a committed-but-not-live removal the page does not adopt, the form stays on its target's row instead of appearing as an extra "no longer listed" row beside it. A committed-but-not-live target write is adopted when the fresh read holds the written list with empty optional members (`path`/`locality` `null`, `tags` `{}`) left out, and the gateway contract now checks that the pinned Edge reads a Foundry-shaped target list — duplicate addresses included — back as written. Add Target and Edit are disabled while a target form is open, so opening another no longer silently replaces its draft, and a target or settings save submitted while another save is in flight says why nothing was sent instead of returning silently. A refused namespace-grant widening in Settings is reported once, on the field, instead of also raising the global error popup; any other `403` from that save is one toast with the BFF's reason. Reordering or respacing the grant text no longer counts as a change. `PUT /api/settings` answers a `jwtNamespaces` that is not an array of strings with `400 FERRUM_BFF_INVALID_SETTINGS` for every session instead of reporting (and logging) it as a widening. The authentication and deployment guides now state that in `trusted-proxy` mode a global admin is expressed only by omitting `X-Ferrum-Namespaces` (the identity proxy must not send it, or must strip it, for that identity), and that a literal `*` — alone or with names — and namespace globs are rejected with `401` for every role, admins included; this behavior is unchanged and is now covered by tests for each role.
- The mobile navigation drawer now opens as a modal dialog, moves and contains keyboard focus, closes with Escape or its close button, and returns focus to the sidebar toggle. The toggle exposes its expanded state and controls relationship (#450).
- Editing a host-only HTTP or HTTPS proxy now keeps its `listen_path` absent instead of changing it to `/`; new proxies still default to the root path (#447).
- Raise the supported Node.js minimums to 22.22.2 and 24.15.0 to match the locked jsdom toolchain; the Quality Gate now tests both minimum patch versions (#452).
- Sessions follow the authentication lifecycle and the browser's shared CSRF cookie. A session read that completes after a confirmed sign-out no longer restores the signed-out principal and CSRF value; an older refresh can no longer overwrite a newer role or namespace grant; and a late `401` — from a session read or from any request through the client's global hook — no longer clears a session accepted after that request was sent. Sign-in, sign-out, and unmounting the provider retire and abort reads in flight, and a replaced provider can no longer publish a token or clear its replacement's cache (#435). When one tab renewed the trusted-proxy CSRF cookie, other open tabs kept sending their own older token and their writes and sign-out were refused with `403 CSRF validation failed` until their next refresh; each unsafe request now sends the current value of the cookie the BFF names in its session response (`csrfCookie`). The BFF's double-submit and signature checks are unchanged (#436).
- A runtime `adminUrl` change no longer lets one gateway's cached data, drafts, or operations cross to another. Every session, settings, and proxied BFF response names its gateway target (`X-Foundry-Gateway-Target`, a keyed digest of the admin origin), each page load binds the first one it sees, and every later gateway-facing request declares it. The BFF refuses a request declared against a replaced target with `409 FERRUM_BFF_GATEWAY_TARGET_CHANGED` before signing or forwarding it, in the same step that reads the configuration it forwards with, so the next page of a listing, a membership plan's later steps, the apply-status poll, a create drafted in an idle tab, and a settings save that would have reverted the change all stop instead of reaching the new gateway. A tab that sees another target — from its own save, the periodic session check, or that refusal — sends nothing more, drops live-apply monitoring so a late answer from the old gateway cannot repopulate it, discards cached reads, and replaces the workspace (editors, confirmations, capability observations) with an explicit reload state. Same-target refreshes and saves leave drafts alone. See `docs/authentication.md` → "Gateway target binding" (#437).
- Effective policy no longer counts a global plugin that the gateway replaces with a same-name scoped instance. When a proxy's `plugins` list attaches an enabled proxy- or proxy-group-scoped configuration, the global configuration of the same plugin name no longer appears in the proxy's effective plugins, plugin counts, consumer access analysis, or a consumer's Matched Proxies, so a proxy-scoped `access_control` that allows a consumer is no longer reported as denied by a global ACL the gateway does not run. This follows Ferrum Edge v0.9.7's scope merge, including its additive exceptions: request and response size limiters, and the exact Istio route-transform consumer, keep the global instance. A disabled or unattached scoped configuration still shadows nothing (#469).
- The Matched Proxies tab no longer scans every plugin configuration for every proxy on each render. Effective-policy resolution now looks each proxy up in a plugin-attachment index built once per plugin collection and reused for every proxy on screen, so a large namespace stays responsive after the tab opens. Matching is unchanged: global, direct, and proxy-group scope, the gateway's protocol filter, priority and id ordering, and the complete-or-unknown policy semantics produce the same plugins and decisions as before (#454).
- BFF: a proxied write whose body the gateway refused unread (or never reached) now gets its response reliably. Instead of closing the connection over the unread upload — which let the kernel reset it, so a client still writing could lose the `4xx`/`502` and see `EPIPE`/`ECONNRESET` — the BFF discards the remainder and reuses the keep-alive connection. A drain lasts at most the request's remaining upload budget or 5 seconds, with `FERRUM_WRITE_TIMEOUT` as its idle bound; it lasts at most 1 second when the request declared a `content-length` over 4 MiB, and at most 1 more second once it has discarded more than 4 MiB, before the connection is closed. A request that timed out its own upload is closed without draining, every drain is abandoned as soon as shutdown begins so it cannot hold the process past `FERRUM_SHUTDOWN_TIMEOUT`, and a sender that outlasts its bound, or arrives while `FERRUM_MAX_ACTIVE_UPLOADS` drains are already running, is disconnected. Drains use their own pool, so an instance can hold up to twice `FERRUM_MAX_ACTIVE_UPLOADS` body-bearing proxied sockets, plus the signed-out drain pool added in #468; see `docs/deployment.md` → "Upload bounds" (#453).
- BFF: an upload refused before it reaches a handler — a `401` or `403` from authentication, or an upload-capacity `429` — is now discarded under the BFF's own drain bounds instead of Node's own discard, which had no concurrency cap and read an unauthenticated sender's body until the server's request timeout (about five minutes). This covers every route, including `/api/settings`. The drain now also sees the bytes it discards when nothing had read the body (every such refusal, and an early `413`/`401`/`409` inside the proxy handler), so the 4 MiB cap applies to a chunked body instead of the drain running for its full time. A request with no authenticated principal drains from its own pool of 8 slots (or `FERRUM_MAX_ACTIVE_UPLOADS`, if lower) for at most 1 second, so unauthenticated senders cannot make a signed-in rejection close its connection instead of draining. `docs/deployment.md` → "Upload bounds" states the exact bounds and now recommends a per-client connection cap at the ingress proxy (#468).
- Effective policy no longer reports a proxy whose only access policy is `access_control` as public. Ferrum Edge v0.9.7 rejects every request with `401` when no plugin has identified a consumer or authenticated identity, whatever the allow or deny lists say, so a proxy with an untriggered ACL and no effective authentication plugin (including one whose only auth plugin is HTTP-only on a stream listener) now reads as denied for every consumer, and its Consumers tab states that the gateway rejects every request. A triggered ACL without authentication, or a plugin outside Foundry's catalog that may establish an identity, is conditional rather than public. A proxy with neither authentication nor an ACL is still public (#470).
- Creating a consumer, and every other write that carries a secret, no longer surfaces or retains a secret the gateway echoes in a refusal. Consumer create (its keys, passwords, and JWT/HMAC secrets), plugin configuration create and update — including a membership plan's rollback — (classified the way Ferrum Edge v0.9.7 projects a plugin configuration for a non-admin read: its per-plugin rules, such as `ai_semantic_cache`'s `semantic_embedding_auth_header`, `proxy_alerts`' `channels.*.body_template`, `api_chargeback_sink`'s `clickhouse.insert_query_params.*`, and every `kafka_logging` `producer_config` property off Edge's safe list such as `ssl.key.pem`, then credential-shaped field names at any depth and the userinfo, path, and query of any URL; every string of a plugin Edge's table does not name), upstream create and update (the Consul `token`), TLS key material and ACME account credentials (managed record create and update, ACME certificate import and replacement, order creation, renewal, and validation), and batch create now apply the credential card's redaction: every such submitted value is replaced by `[REDACTED]` throughout the gateway's error body — raw, JSON-escaped, trimmed, and line by line for a multi-line value such as a PEM key, whose armor lines stay readable — before any field is trimmed or shortened for display. The failure reaches the page as a plain error that keeps the status and the redacted body but not the request, its options, or a `cause`. The global error popup is still raised for these writes, with the same status, URL, and outcome but the redacted body, so a write whose answer was lost still opens the "Outcome unknown" dialog. The plugin, upstream, and TLS mutations no longer keep their submitted body in the mutation cache once the form is gone. A plugin membership plan's failure message now includes the gateway's (redacted) reason (#478).
- Guided plugin edits preserve literal string values such as `"null"` and keep explicit JSON `null` only when it was actually read as null. Editing another field no longer changes Redis prefixes or usernames, and a newly typed Redis password of `null` remains a string (#483).
- BFF: `FERRUM_JWT_SECRET` is now used exactly as configured. The BFF trimmed surrounding whitespace from it before signing, while Ferrum Edge verifies with its `FERRUM_ADMIN_JWT_SECRET` verbatim, so the same key with leading or trailing whitespace set on both produced tokens the gateway refused with `401`. A blank or whitespace-only value is still refused at startup, and the 32-character minimum is now measured in UTF-8 bytes, as the gateway measures it, in both the BFF and the shared signer used by the demo seeder, which also no longer trims the key (#486).
- A failed backup restore, API spec import, or API spec replacement no longer surfaces or retains a secret the gateway quotes back. Each is now reported like the other secret-bearing writes: the error keeps the status and the body with every submitted secret replaced by `[REDACTED]`, but not the request (the whole backup or spec document), its options, or a `cause`, and a spec write whose outcome is unknown keeps only that redacted error. For a restore, the secrets are the backup's consumer credentials, plugin configuration secrets, and other credential-shaped values, plus each API spec document it carries. A JSON spec document is classified by position, each `x-ferrum-plugins` entry by its plugin's rules; a YAML document cannot be parsed in the browser, so every scalar in it is treated as secret. The restore card's recovery details, the API spec deletion confirmation, and the outcome-unknown handling read the redacted error unchanged, including when a credential in the backup is a short word such as `api` or `true`: no value shorter than 8 characters is matched in the body's keys or in the top-level fields those checks read (`code`, `phase`, `rollback`, `failure_class`, `confirmation_required`); a nested field of the same name is redacted in full. A YAML spec document's value after a quoted key with no space (`"api_key":"…"`, as in a document that is almost JSON) a double-quoted value continued onto the next line with a trailing `\`, also as the joined whole, and each of several key and value pairs on one line are now found too. The redacted error keeps the original error's name, so a client timeout is still reported as one, and the restore and API spec import and replacement mutations no longer keep the backup or document in the mutation cache once the page is gone (#485).
- Redaction no longer destroys the gateway's error detail when a short value is treated as secret only because nothing classifies it, such as a string in an unknown plugin's configuration or a scalar in a YAML spec document. A value like `a`, `1`, `on`, or `error` that is shorter than 8 characters is now redacted only where it stands as a whole word in a string, and never in an object key, so the body's `error` key, its code, and the `[REDACTED]` markers stay intact. A classified secret is still redacted wherever it appears in a string value, whatever its length. Every match is now found in the original text and replaced in one pass, so one replacement can no longer split another's marker. Ferrum Edge's plugin sensitivity table is now in `src/api/pluginSensitivity.ts`, together with the Edge commit it was checked against. The Pinned Gateway Contract job fetches Edge's `plugin_config_projection.rs` at the pinned commit and fails if Foundry's table differs. The table's unit test fails if the recorded commit is not the pinned one, so moving the Edge pin requires re-checking the table (#487).
- Scanning a YAML API spec document for secrets no longer slows down sharply on a long flow list, a long chain of quoted keys, or deeply nested flow brackets: each distinct scalar on a line is expanded once, and splitting a flow collection is linear in its length. A double-quoted value continued with a trailing `\` is now also recorded as the joined whole, over any number of lines, when a quote earlier in the document — in a comment or in block-scalar prose — has put the line scan out of step with it. A block scalar's content line that ends in a colon, such as `secretpart:`, is scanned instead of being skipped as a bare key, including under `- key: |` and `- |` (#491).
- YAML secret scanning now recognizes block-scalar headers with anchors and tags, so key-shaped scalar content is included. Comment lines that resemble block headers no longer make following key-only prose redact as a secret; ordinary block headers retain their existing collection behavior (#493).

## [0.2.0] - 2026-09-25

The first Foundry release paired with a published Ferrum Edge release:
**Ferrum Edge v0.9.7**, `ferrumedge/ferrum-edge@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a`.
See `docs/compatibility.md` and `docs/release-notes/v0.2.0.md`.

### Changed

- Foundry v0.2.0 pairs with the published Ferrum Edge v0.9.7 release (commit `8fed1346ce2e267eb69c03683cb89ea44d785e0b`; `linux/amd64` `sha256:e4d4367e815e86f510c28d8f831ca3502b7c9d5f21fd0eeabeb609a8c8e6f47f`, `linux/arm64` `sha256:7d3d28d2529dfb6a303b734fad0bf35ebec07caa95f5632e81d92170baf15fab`). It is recorded as `edge.release` and is `edge.image`, so CI, the deployment starter, and the local-run instructions run it instead of v0.9.5. v0.9.7 is the first published Edge release after v0.9.5 (v0.9.6 was tagged but never published) and includes ferrum-edge#5661, so guarded full-replacement saves and detail-page deletes are now atomic against the qualified gateway: a writer that commits between the guard's verification read and the write is refused with `412`. `package.json` and `foundry.version` are `0.2.0`, and the release notes are `docs/release-notes/v0.2.0.md` (#385, #439).
- The gateway contract now requires what the pairing depends on: the pinned gateway must issue strong `ETag`s and refuse stale and invented `If-Match` tags with `412`, a malformed `If-Match` and one on a create with `400`, and the upstream probe targets Edge v0.9.7 refuses; and `GET /plugins/config?proxy_id=` must return exactly the proxy's configurations, an empty page for an unknown id, and `400` for an invalid one (#385, #439).
- TLS managed stores and ACME certificates, orders, and accounts now use server pagination and fetch only the visible page. ACME order pages poll only while an order on that page can still change (#431).
- CI, the deployment starter, and the local-run instructions now run the published Ferrum Edge v0.9.5 release, `ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f` (commit `20e76030a05dc49c3804e969516c94ab101110b9`), instead of the pre-0.9 development build `main-b96cfaa…`. v0.9.5 moves out of `edge.rejected_images`: the two failures recorded against it were Foundry assertions encoding pre-0.9 behaviour. The first-success walkthrough (`scripts/starter-journey.mjs`, `docs/getting-started.md`) now shows that Edge attaches a proxy-scoped plugin configuration to its proxy on create (ferrum-edge#4611), so the route is protected at once, and still proves the manual attach is idempotent and the route refuses anonymous and wrong-key callers. The namespace-isolation journey now asserts that the same id in two namespaces is two independent resources (ferrum-edge `5db1d77a8`) — reads, writes, deletes, lists, a namespace switch, and a late response for the previous tenant all stay with their namespace — instead of expecting a `409`. The plugin membership plan was checked against Edge's attach-on-create and re-home proxy bumps, with tests pinning that they never trip its stale-write checks. v0.9.5 lacks ferrum-edge#5661, so the supported pairing still needs the next Edge release (#409).
- The Ferrum Edge image CI qualifies now has a single source, `edge.image` in `docs/compatibility.json`. CI reads the gateway image from it, and `scripts/supported-pairing.test.mjs` fails when the starter, the local-run instructions, the README, or any doc pins a different Edge image or names a rejected one. The pin stays on the interim development build `ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d` (`main-b96cfaa…`, 2026-08-27), because no published Edge release qualifies yet. Ferrum Edge v0.9.5 (`ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f`) was evaluated and fails the Deployment Starter walkthrough and a critical journey ([CI run 35901872338](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/35901872338)). The first supported pairing needs the next published Edge release; its requirements are recorded as a release step, and the release workflow refuses a tag until that release is recorded and CI runs it (#385).
- Ordinary navigation no longer downloads whole namespace collections. Opening the proxy list fetches one page of rows and names their upstreams from one catalog page (or, in a namespace larger than that page, one read per visible row); opening a proxy editor issues exactly one request, with plugin, consumer, and upstream reads deferred to the tab that needs them. The list's effective-plugin column stops at a budget and reports the count as unavailable at that size rather than a number derived from a partial scan, while the policy views that produce authorization conclusions still traverse completely or report unknown. Collection traversals now carry the query's abort signal, so a namespace switch abandons them instead of paying for pages nobody will read. Measured against a 50,000-record fixture, opening the proxy list went from 200 requests and 11.5 MB to 2–22 requests and under 75 KB. Server-side search still needs an upstream contract and is documented as such. See `docs/data-loading.md` (#382).
- Local gateway setup docs pin `ferrumedge/ferrum-edge:v0.9.5` instead of the stale `latest` tag and note that release images are chosen from upstream releases (#361).
- Local gateway setup docs now run the same image digest as the `Pinned Gateway Contract` CI job, the e2e suite, and the deployment starter, so local checks exercise the gateway CI does. Agent instructions no longer ship the Rust gateway's `.claude/rules` (which loaded Cargo test and CI policy into Foundry sessions), and the agent-dispatch skills drop leftover gateway vocabulary, fixed update cadences, and the duplicate Fable 5 skill (#395).

### Added

- A proxy's Plugins tab lists the proxy-scoped plugin configurations that name the proxy but do not run on it — disabled, or not in the proxy's `plugins` list — which no view showed before. The list comes from `GET /plugins/config?proxy_id=` (Ferrum Edge v0.9.7, ferrum-edge#5726), so it costs that proxy's configurations rather than a namespace traversal, and a response the gateway did not filter fails the read instead of being shown. The mock admin gateway implements the filter (#385, #439).
- The upstream form checks an active health check's `http_path` (must start with `/`) and `udp_probe_payload` (whole hex bytes) before submitting, matching the admission rules Ferrum Edge v0.9.7 added (ferrum-edge#5683, #5688); the mock admin gateway refuses both with Edge's messages (#385, #439).
- A versioned compatibility record (`docs/compatibility.md`, `docs/compatibility.json`). It names the Edge image CI qualifies and the Edge release the next Foundry release must pair with. The requirements for that release are ferrum-edge#5661 (atomic concurrent-edit protection, which no published Edge release includes yet), agreement with the starter walkthrough and critical journeys, and a full re-qualification. The record also lists the Edge releases evaluated and rejected, the tested envelope (modes, roles, authentication, deployment path, browser, container platforms, measured scale), what is best-effort, and what is not qualified. Release notes are drafted in `docs/release-notes/UNRELEASED.md`. The release workflow now requires `docs/release-notes/vX.Y.Z.md`, a matching `foundry.version`, and `supported-pairing.mjs release-ready` before building, and publishes those notes as the GitHub release body (#385).
- Role and mode capability parity against the pinned gateway. `scripts/capability-parity-contract.mjs` sends every gateway-backed capability surface a non-mutating probe as `viewer`, `operator`, and `admin`, on a writable gateway and on a second one started with `FERRUM_ADMIN_READ_ONLY`, and fails when the gateway's answer disagrees with the UI's capability model. It also requires every role to receive real collections for the launch surfaces, and a read withheld from a role to be an explicit `403` naming the role rather than a `404`/`503` that Foundry would present as a missing feature (#385).
- A critical-journey release gate: a real browser driving the production-built SPA and BFF, behind the documented identity-aware proxy, in front of the pinned Ferrum Edge gateway and a disposable backend, finishing with real data-plane requests. Six journeys cover the first route end to end, the authorization matrix through the actual proxy, namespace isolation, edit/delete verified against gateway state, transient versus unavailable reads, and a write whose outcome is genuinely unknown. Failures are arranged exactly — `e2e/fault-proxy.mjs` fails the next N requests matching a method and path, and journeys assert their faults were consumed — so nothing passes by retry; `retries: 0`, and `npm run e2e:gate-self-test` refuses every gateway write and requires the critical journey to fail, so the gate cannot go vacuous. Traces, screenshots, video, and stack logs are retained on failure, and image publication waits on the job. See `e2e/README.md` (#380).
- A maintained deployment starter (`deploy/starter/`) and a first-success walkthrough (`docs/getting-started.md`): one Compose stack for the documented production topology, and a `demo` profile that brings up a disposable gateway, backend, and stub identity provider so a new operator can go from nothing to an authenticated request through the real data plane. The group-to-role policy and the four identity headers are shared includes, so the demo exercises the production authorization path rather than a look-alike. `scripts/starter-preflight.mjs` reports configuration, gateway reachability, TLS trust, signing-key/audience compatibility, namespace grants, and the trust boundary, distinguishing an unknown from a pass; `scripts/starter-journey.mjs` executes the walkthrough and asserts anonymous denial, unmapped-user denial, forged-header stripping, role and namespace grants, and authenticated data-plane success. Both run in CI against the production image and the pinned gateway, and publication is gated on them (#384).
- Guided configuration for `key_auth`, `rate_limiting`, `cors`, and `prometheus_metrics`: labelled controls with the schema's own descriptions, enums, bounds, and patterns, inline accessible validation before submission, and explicitly unconfirmed notes for prerequisites only the deployment can satisfy. The advanced JSON editor remains one click away and stays the complete surface. Edits are lossless — unmodelled keys, key order, and the difference between an absent field, an explicit `null`, and an empty value all survive a JSON → guided → JSON round trip — and a configuration the field set cannot represent (a multi-rule rate-limit policy, Istio `StringMatch` CORS origins, an Istio-projected CORS policy) falls back to raw JSON with its reason rather than being rewritten. Field descriptors are transcribed from named `openapi.yaml` components with each component's SHA-256 pinned; `npm run check:plugin-schemas` re-fetches the spec on every pull request and fails on drift. See `docs/plugin-schemas.md` (#383).
- TLS → Validate exposes the full `TlsValidateRequest`: CRL PEM, `allow_expired`, and `cert_expiry_warning_days` with inline validation, and every TLS textarea, inline error, and destructive record button now has an accessible name (#362, #363).
- Vite's dev-server port and `/api` proxy target are configurable through `VITE_DEV_PORT`, `PORT`, and `VITE_BFF_URL`, so Foundry can run alongside another Vite app such as Nexus without editing `vite.config.ts` (#327).
- `VITE_DEV_HOST` selects Vite's listen address (`localhost` by default; `127.0.0.1` forces IPv4 loopback). Dev docs use `localhost` for the SPA origin and BFF cookie host so dual-stack `localhost` vs `127.0.0.1` 401s are not the default path (#344).
- A client-side capability model derived from the session role and the gateway's reported mode. Surfaces a session cannot write — a `viewer` on any gateway, any role on a `file`/`dp`/`mesh`/`node_agent` gateway or one reporting `admin_writes_enabled: false` — render read-only with the reason visible before anything is edited, instead of accepting a full form and failing with `403`. Each surface names the upstream write gate it mirrors, so managed TLS/ACME material is correctly refused in a read-only mode while staying off the config-database failover gate, and rotate/validate stay available. A read-only form still shows everything the editable one does: collapsible sections are forced open and Cancel stays usable. Server-side authorization is unchanged, and an unread health snapshot never downgrades a surface. `MOCK_GATEWAY_MODE` reproduces a read-only admin API against `scripts/mock-admin-gateway.mjs` (#359).

### Fixed

- A failed initial `GET /api/settings` no longer renders `DEFAULT_SETTINGS` as though they were the server's configuration. The form now keeps an explicit unobserved-read state: a terminal failure shows a persistent "Unable to load settings" card with an inline Retry, a `403` is presented as a permission denial rather than unavailable data, and no immutable/mutable conclusion, authentication mode, issuer, or timeouts are asserted until a settings response has actually loaded. Retry adopts the canonical response and restores the appropriate controls (#438).
- A proxy, upstream, or consumer save or delete that Ferrum Edge answers with the committed-but-not-live `503` (`X-Ferrum-Config-Cursor` or `applied: false`) is now handled as the committed write it is, not as a failure. There is no "API Error 503" popup — the live-apply banner already reports the lag — cached reads are refreshed, and the editor says the change was saved and is not yet proven live instead of "Failed to update". The editor reseeds its form and write-guard baseline from one fresh read, so pressing Save again is no longer refused as a concurrent edit listing the operator's own change; a committed delete leaves the page like any delete and retires the seeded detail and list caches. Targets and ACL edits that commit this way close like a success, and a credential write keeps the committed marker. Restore, the live-apply monitor, and the client share one predicate for the distinction. See `docs/concurrent-edits.md` (#430).
- Authorization and write-safety fixes. Switching an `mcp_gateway` configuration to transparent mode and back restores its aggregate state exactly — including an empty one that relied on the gateway's default policy — instead of merging in a sample deny-by-default policy with a `github.search_issues` allow rule (#412). After a `412`, the write guard refuses rather than sending an unconditional `PUT` when the re-read comes from the untagged cached-config fallback, which could revert the commit that caused the `412` (#413). The effective-policy views count a proxy-scoped plugin only when the proxy's `plugins` list names it, so an orphaned auth plugin no longer shows an anonymous route as protected (#414).
- Saves no longer drop or invent configuration. Kubernetes service discovery `address_type` is modelled, and every provider key the form does not model survives an upstream save (#415). Picking a plugin on the create page seeds its default config before the guided editor mounts, so `key_auth` keeps `key_location` (#416). Empty guided integer fields and a cleared ACME expiry-warning field are no longer coerced to `0`, and whitespace typed over a stored secret is flagged instead of replacing it (#417). An empty HTTP method restriction is refused inline instead of reaching the gateway as `allowed_methods: []`, and Enter in the proxy picker selects the first match instead of submitting the plugin form (#426).
- BFF: a proxied write whose body the gateway refused unread (or never reached) now closes the client connection, instead of stranding the next request on that keep-alive socket until the 305 s request timeout (#418). The SPA fallback serves `index.html` only for `GET`/`HEAD` page navigations, and answers `404` for missing `/assets/` chunks, other methods, and `/api` (#419). Runtime-selected admin origins can no longer reach private IPv4 ranges through NAT64, 6to4, or IPv4-compatible IPv6 spellings, which are now judged by the IPv4 address they embed, so a DNS64-synthesized public origin still works; local-use NAT64 and site-local ranges are blocked (#420).
- Cache and state consistency. Plugin membership plans refresh cached proxy details, and deleting or renaming a namespace retires every query scoped under the old name (#421). The audit log starts at its first page after a namespace switch, and TLS Inventory and Events no longer share one page offset (#422). Mesh views render a `403` as a denial and a `500` as an unknown state, not as "only served in mesh mode", and keep the last data on a failed poll (#423). The proxy, upstream, and consumer editors and consumer credential drafts stay mounted across tab switches, a refused target save keeps its draft and removing a row above an open target editor no longer moves it to another target, and the Edit Namespace dialog no longer overwrites a rename typed while details load (and stays editable if they fail to load) (#424).
- Metrics: the dashboard's requests per second ignores a stored sample from an earlier visit, the status page no longer flashes a stale warning on every refresh, and a latency percentile beyond the top histogram bucket renders as a lower bound (#425). The mock gateway's `/metrics` now matches Edge's Prometheus exposition (#429).
- Bounded loading. A consumer editor loads its matched-proxy policy only when that tab opens, analyzes only that consumer, and never traverses the consumer collection. A plugin editor traverses proxies only for a `proxy_group` plugin. The API spec and TLS traversals take the Query's abort signal, and ACME orders poll only while one can still change (#427).
- Accessibility: one shared `TagInput` labels its field and names each remove button, and collapsible sections expose `aria-expanded` (#428).
- A read the gateway refuses with `403` is presented as a denial for the session, not as missing data. On the TLS page a `viewer` — whom Ferrum Edge refuses every TLS read — previously saw "No TLS material found" and empty certificate, ACME, and event lists; each panel now says the read is not permitted for this session. `ReadStateNotice` does the same for every other read it guards, instead of a generic "unavailable" (#385).
- The concurrent-edit guard now covers consumers, plugin configurations, and deletes. A consumer Details or ACL save, and a plugin configuration save, is refused with the stale-write dialog if the resource changed since the editor opened, and is sent with `If-Match` from the read it was checked against. A consumer save's credentials come from that same read, so a rotation landing in the gap is re-read rather than replayed. Every write inside a plugin membership plan is now conditional on the read its `updated_at` preflight compared, which also catches a change that did not move `updated_at`. Deleting a proxy, upstream, consumer, or plugin configuration from its detail page is refused, with the same dialog and no "delete anyway", if another writer changed it since the page last showed it. `labels` are left out of the consumer and plugin comparisons: those saves never send them and Edge preserves an omitted map, so a provisioner stamping a label is not a conflict. Plugin configurations can now reach the conflict dialog, so its redaction also covers header-shaped secrets inside a plugin's `config` (`Authorization`, `Cookie`, bearer values). `scripts/mock-admin-gateway.mjs` implements the `ETag`/`If-Match` contract so all of this can be exercised locally. See `docs/concurrent-edits.md`.
- Guarded full-replacement saves of proxies, upstreams, and upstream targets are now atomic on a gateway that implements ferrum-edge#5661: the `PUT` carries `If-Match` with the `ETag` of the verification read the guard just compared, so a writer that commits between that read and the write is refused with `412` instead of overwritten. After a `412` the guard re-verifies; a change to a field the save would overwrite opens the stale-write dialog, and a change only to fields it leaves alone (a plugin association, upstream settings during a targets save) is re-sent against the fresh tag, at most three times. A read without a strong `ETag` — an older gateway, the cached-config fallback — keeps the previous verification-read behavior. `scripts/concurrent-edit-contract.mjs` now asserts the `412` on a gateway that tags reads instead of failing on it. See `docs/concurrent-edits.md`.
- Full-replacement saves from a detail editor no longer silently revert another session's accepted change. The editor captures the content it was seeded with, the API layer re-reads and compares it immediately before the `PUT`, and a mismatch refuses the write without sending anything — including a change made by a second Foundry deployment, the seeding scripts, or any direct admin-API client. The refused draft is preserved and shown against the gateway's current content with credential-shaped values redacted; there is no "save anyway" and nothing is ever resent automatically. On its own this narrows the race to one round trip rather than closing it; `scripts/concurrent-edit-contract.mjs` records the gateway's behavior against the pinned image on every pull request. See `docs/concurrent-edits.md` (#381).
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
- The agent-dispatch skills no longer tell dispatched workers to run `npm ci`, builds, tests, typecheck, or lint locally. Those commands execute repository-controlled code from the branch under review on a host that holds provider and maintainer credentials. Workers now inspect source only and use remote CI on the exact pushed head as the build and test gate.

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

[Unreleased]: https://github.com/ferrum-edge/ferrum-foundry/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/ferrum-edge/ferrum-foundry/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ferrum-edge/ferrum-foundry/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ferrum-edge/ferrum-foundry/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.1.0
