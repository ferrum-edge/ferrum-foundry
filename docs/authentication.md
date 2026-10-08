# Production authentication

Ferrum Foundry keeps browser authentication separate from the JWT it mints for
the Ferrum Edge Admin API. The browser never receives the gateway signing key
or a reusable administrator token.

Every environment variable named here is listed with its default and range in
the [configuration reference](deployment.md#2-configuration-reference).

## Production: trusted identity proxy

Run Foundry behind an OIDC/OAuth2-capable reverse proxy. The proxy owns the
login flow, MFA, the user session, account revocation, and group-to-role
policy. On every request Foundry checks a shared proof header, then turns the
asserted actor, role, and namespace grants into the downstream Ferrum JWT.

```bash
export NODE_ENV=production
export FERRUM_AUTH_MODE=trusted-proxy
export FERRUM_TRUSTED_PROXY_SECRET="$(openssl rand -hex 32)"
export FERRUM_ADMIN_URL=https://ferrum-admin.internal:9000
export FERRUM_JWT_SECRET="$(openssl rand -hex 32)"
export FERRUM_AUTH_LOGIN_URL=/oauth2/start
export FERRUM_AUTH_LOGOUT_URL=/oauth2/sign_out
```

The proxy must strip any client-supplied copy of these headers and inject its
own:

| Header | Meaning |
|---|---|
| `X-Ferrum-Auth-Secret` | Exactly `FERRUM_TRUSTED_PROXY_SECRET` |
| `X-Forwarded-User` | Stable person or service identity, used as JWT `sub` |
| `X-Ferrum-Role` | `viewer`, `operator`, or `admin` after group mapping |
| `X-Ferrum-Namespaces` | Comma-separated exact namespace grants; omitted for a global admin |

The last three names can be changed with `FERRUM_TRUSTED_PROXY_USER_HEADER`,
`FERRUM_TRUSTED_PROXY_ROLE_HEADER`, and
`FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER`. Each of the four headers may appear
only once per request.

Startup refuses identity header names that would let one header carry two
meanings. Compared case-insensitively, the four names must all differ (a
role header that is also the namespace header would read a grant as a role;
a user header that is also `X-Ferrum-Auth-Secret` would return the proof as
the actor), and none may be a header HTTP or the BFF already uses, such as
`Authorization`, `Cookie`, `Host`, a hop-by-hop header, `X-CSRF-Token`,
`X-Ferrum-Namespace`, or `X-Foundry-Gateway-Target`. The full list is in
[Deployment](deployment.md#the-proxy-must-strip-and-inject-these-headers).

Namespace header rules:

- A non-admin identity without the namespace header is rejected.
- A global admin is expressed only by **omitting** the header. There is no
  wildcard: `*` in any form (alone, repeated, or mixed with names) and glob
  patterns such as `tenant-*` are rejected with `401` for every role, admins
  included. `*` is valid only in `FERRUM_JWT_NAMESPACES` and the runtime
  settings, which configure the static principal.
- A header that is present but empty or whitespace-only is rejected with `401`
  for every role. It is never read as "omitted".
- Empty entries between names (`tenant-a,,tenant-b`) are dropped, but at least
  one name must remain.

nginx does not forward a `proxy_set_header` whose value is empty, so the
starter's identity proxy omits the header for an identity with no mapped
namespaces.

### Network exposure

Do not expose the BFF port to an untrusted network. Terminate TLS at the
identity proxy, strip every identity and proof header the client sends, inject
the trusted values after authentication, and firewall the BFF so only that
proxy can connect. When the proxy runs on the same host, set
`FERRUM_BIND_ADDRESS` (default `0.0.0.0`) to a loopback or private address such
as `127.0.0.1` or `::1`. Configure the proxy to revoke a user's session as soon
as the identity provider disables the user.

### Namespace registry

Registry requests are authorized against the namespace they actually target:
`GET`, `PUT`, and `DELETE` check the name in the path, `POST` checks the name
in the body, and a rename checks both the old and new names. Registry writes
require `admin`. The selected `X-Ferrum-Namespace` header cannot grant access
to a different registry target.

A namespace DELETE without `confirm` is the unconfirmed attempt used to let the
gateway report whether the namespace is empty. In the UI, an occupancy `409`
opens a second step that requires typing the namespace name. A cascade request
must carry exactly one literal query value `confirm=<namespace-name>`. The BFF
compares it with the once-decoded target name using the complete query,
including any later `?`, before forwarding the validated decision to Edge as
its existing `confirm=true` contract. Mismatched names, encoded spellings of
the value, duplicate confirmations, and ambiguous query serialization are
rejected with `400` before contacting the gateway. `confirm=true` is accepted
only when the target namespace is literally named `true`.

This is a stateless exact namespace acknowledgment, the exact-name alternative
in [#531](https://github.com/ferrum-edge/ferrum-foundry/issues/531). It does not
prove a prior occupancy `409`, that someone typed the name in the UI, freshness,
or single use. An authorized direct BFF caller can send the exact echo without
the UI's first step and can repeat it. Authentication, CSRF validation, the
admin role, namespace grants, and the gateway's deletion restrictions still
apply to every request.

Foundry validates registry JSON within the ordinary 2 MiB body limit before
forwarding it. A scoped principal's registry list is filtered to its exact
grants before pagination, so totals count only granted names. The namespace
manager and the header selector use the same grants.

These BFF checks apply even when the gateway does not enforce namespace
claims. For a second enforcement layer on multi-tenant deployments, also set
`FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` on Ferrum Edge.

### Roles in the UI

A surface whose write the current role or gateway mode cannot perform is shown
read-only, with the reason visible before anything is edited. This is a
usability layer only; the BFF and Ferrum Edge remain the enforcement points.
See [Capabilities](capabilities.md) for the role and mode matrix.

### Namespace route ceiling

A namespace grant scopes only the Ferrum routes that take
`X-Ferrum-Namespace`. For a session with grants, Foundry refuses every other
gateway route with `403 Namespace access denied`, before signing a JWT or
contacting the gateway. Anything not explicitly allowed is denied, so a new
Edge admin route is refused until Foundry classifies it. The classification is
in `server/proxy-path.ts`.

- **Allowed namespace-scoped routes** mirror Edge's
  `namespace_scoped_resource_kind`: the `proxies`, `upstreams`, `consumers`,
  `plugins/config`, `api-specs`, and `gateway-trust-bundles` resources; the
  `gateway-trust` status; `POST /batch`, `GET /backup`, and `POST /restore`;
  `GET /proxies/{id}/mcp/tools`; `GET /config/export`; `GET /audit`; and
  `GET /backend-egress-policy`.
- **Allowed fleet-wide routes** are Edge's viewer-key ceiling minus its
  detailed observability views: `GET /plugins`, the `/namespaces` registry,
  and `GET /live`.
- **Refused fleet-wide routes** include `/health`, `/status`, and `/overload`.
  Foundry signs with the primary key, which Edge treats as detail-authorized,
  so a scoped principal would otherwise receive the full listeners, `dp_config`,
  `cp_dp_trust`, and database-failover projection. `/cluster`, `/mesh/*`
  (including `/mesh/egress-scope`), `/charges`, `/metrics`,
  `/backend-capabilities`, the waypoint routes, and every unknown path are also
  refused. `GET /config/apply-status` is deliberately permitted for a scoped
  principal because the UI's post-mutation apply confirmation depends on it; it
  is process-topology in Edge and reveals only a monotone apply cursor.

The credential-read denial and unsafe-path checks run before the ceiling, so
`/consumers/{id}/verification` and `/deployment-snapshot` keep
`403 FERRUM_BFF_CREDENTIAL_READ_DENIED` and an unsafe path keeps
`400 FERRUM_BFF_UNSAFE_PATH`, whatever the namespace grants.

### Fleet-global TLS routes

Namespace grants apply to Ferrum operations that take `X-Ferrum-Namespace`.
They do not make fleet-global APIs tenant-scoped. TLS inventory, managed TLS
material, ACME, validation, and the create/replace operations are fleet-global,
so Foundry sends no namespace header for them and labels the surface as
fleet-global. A scoped principal may read fleet TLS material, but rotation and
deletion are refused by the namespace route ceiling above; block the remaining
routes at the identity proxy if a scoped identity must not reach them at all.

Only the TLS paths and methods listed in `server/proxy-path.ts`
(`FLEET_GLOBAL_ROUTES`) are fleet-global. A new Edge TLS operation must be added
to that list; `FLEET_GLOBAL_SCOPED_DENIED_ROUTES` names the methods withheld
from scoped principals.

### Proxy path validation

The BFF validates each proxied path from the raw request target. Each segment
is decoded exactly once. Control characters, dot segments, encoded separators,
repeated separators, malformed escapes, and nested escapes are refused with
`400 FERRUM_BFF_UNSAFE_PATH`. Ordinary escaped identifiers still work. Namespace
authorization, body limits, upload admission, and deadlines all use the same
normalized path that is sent upstream.

### Credential-complete reconciliation reads

Edge's `/consumers/{id}/verification` and `/deployment-snapshot` disclose
credential-complete reconciliation evidence. Foundry refuses both through
`/api/proxy/*` with `403 FERRUM_BFF_CREDENTIAL_READ_DENIED` for every forwarded
method, including HEAD. The decision uses the same canonical pathname sent
upstream: encoded route components and identifiers, an optional trailing slash,
and queries cannot bypass it. Unsafe paths still receive
`400 FERRUM_BFF_UNSAFE_PATH`.

Principal authentication and CSRF run first, then the credential-read denial.
The namespace route ceiling runs after it and before capacity admission, JWT
signing or upstream fetch, even for an authorized administrator. Foundry has no
credential-complete consumer reader; ordinary masked consumer reads and the
existing masked metadata write workflow remain supported. Intentional archival
backup downloads are described in
[Backup export](concurrent-edits.md#backup-export).

Edge v0.9.13 and v0.9.14 keep the snapshot secret-complete: its evidence
carries stored spec documents only as SHA-256 and length, but the
`api_spec_contents` array returns one base64 copy of every stored spec
document. The path-based
refusal is unchanged. Conditional snapshot paths that Foundry itself never
issues (`GET /backup?conditional=true`, a tagged `POST /restore` and the two
deployment mutations) can answer a deterministic
`507 Insufficient Storage`; the BFF relays that status and body unchanged and
releases the request's capacity permit like any other answer. Edge v0.9.14
also separates a deployment mutation's `durable: "not_started"` and
`durable: "not_committed"` `503` outcomes from `"unknown"`. Foundry issues no
deployment mutation and shows none of these outcomes; the BFF relays such an
answer unchanged.

### Runtime identity defaults

`GET /api/settings` includes the active `authMode`. In `trusted-proxy` mode:

- The Settings page disables the role and namespace defaults and leaves them
  out of saves.
- `PUT /api/settings` with `jwtRole` or `jwtNamespaces` is refused with
  `400 FERRUM_BFF_PROXY_MANAGED_IDENTITY`, and nothing is applied. Change the
  identity proxy's policy to change user access.
- The reported `jwtNamespaces` describes only the readiness probe's scope.

In static development mode the defaults are editable and apply to the static
principal on its next login. Existing sessions keep their original grants.
Issuer, audience, and token lifetime are signing settings in both modes.

`jwtNamespaces` follows the `FERRUM_JWT_NAMESPACES` rules:

- Omitting it leaves the current value unchanged.
- A value must be an array of strings naming at least one exact namespace, or
  `["*"]` for every namespace. Empty entries are dropped.
- An array with no name left, an invalid name, `*` mixed with names, or a value
  that is not an array of strings is refused with
  `400 FERRUM_BFF_INVALID_SETTINGS`, and nothing is applied. The shape check
  runs first, so a malformed body is never reported as a widening.
- `GET /api/settings` always includes it, reporting an unrestricted static
  principal as `["*"]`.

A session that holds namespace grants may only choose grants it holds.
Anything wider, including `["*"]`, is refused with
`403 FERRUM_BFF_NAMESPACE_GRANT_EXCEEDED` and logged as a warning naming the
actor and the requested grants. The Settings form leaves the field out of a
save when it is untouched (the same grants in another order or spacing count
as untouched), so a narrower session can still save other settings. A refused
widening is shown on the field; any other `403` is shown once as a toast with
the BFF's reason.

### Namespace binding

**An operation is bound to the namespace that was active when it started, and
every request it makes carries that binding.** The namespace in the header
selector is therefore the namespace every gateway request from that tab
carries.

- `NamespaceProvider` (`src/stores/namespace.tsx`) owns the active namespace
  for each tab. A hook or page captures it as an immutable scope when a query
  or mutation starts, and the API layer stamps `X-Ferrum-Namespace` from that
  scope. The HTTP client never picks a namespace. A gateway request with no
  binding that is not a known fleet-global call is refused before it is sent.
- The binding covers every request in an operation: each page of a listing,
  query retries, a plugin membership plan's reads, writes, and rollbacks, a
  namespace restore, and the apply-status poll after a mutation. A later
  switch, in this tab or another, does not retarget it.
- Registry rename and delete update the affected cache entries even if the
  dialog has closed. The tab follows the renamed namespace (or leaves the
  deleted one) only if that namespace is still the current selection; a newer
  user selection is kept.
- The active namespace is checked against the principal's grants during
  render, not in an effect, so the first queries after a load or a grant change
  already carry a granted namespace. A retired name is replaced and the
  corrected value saved. A global admin keeps its stored preference.
- `localStorage` (`ferrum:namespace`) holds a *preference*, not the active
  namespace. It is read once when a tab loads and written when the user
  switches. Cross-tab `storage` events are ignored, so another tab's switch
  never changes what this tab shows or sends. Two tabs can work in different
  namespaces at once.
- When storage is unavailable, the provider starts from the default namespace
  `ferrum` and keeps state in memory. Only the preference is lost between
  loads.

Create forms for consumers, proxies, upstreams, and plugins discard their
draft, including plugin membership selections, when the tab switches
namespaces. A proxy id supplied by a create link applies only in the namespace
where the link was opened. Background refreshes in the same namespace leave a
draft alone.

To guarantee an identity can never write outside one namespace, grant exactly
that namespace at the identity proxy. The binding keeps the UI consistent; the
BFF's grant check is what enforces access.

### Proxy form updates

A proxy settings save omits `plugins`, so Edge keeps the live plugin
associations. An unrelated edit never replays a cached association list.
Plugin membership operations still send an explicit list when they change or
clear associations.

### Editor identity

Binding requests is not enough on its own. If both tenants' data is cached, a
detail page re-renders on a namespace switch without a loading state, so a form
seeded once could show the previous tenant's values under the new heading and
submit them to the new tenant. Foundry therefore binds the **editor** too
(`src/lib/editorIdentity.ts`, `src/hooks/useEditorIdentity.ts`):

- An editor's identity is `{ namespace, resourceId }`. The proxy, consumer,
  plugin, and upstream detail pages key their whole editor subtree on it: the
  form, credential drafts, inline target editors, the membership recovery
  notice, and every confirmation dialog. A namespace switch or a route change
  remounts the editor. Fields are re-seeded, an open delete confirmation
  closes, and a half-typed credential is discarded. If the new resource is not
  cached, the editor shows its loading state. The API specs list page uses the
  namespace alone as its identity.
- Submit and confirm handlers capture the identity they were created under
  (`bind()`). If the page has moved on when they run, they are discarded and a
  toast says so. A write already in flight still completes against the
  namespace it started in and never touches the editor now on screen.
- **Fields are seeded once per identity.** A background refetch of the same
  resource (a poll, an invalidation after a save, a newer `updated_at`) never
  rewrites fields, dirty or clean. Live data still drives the heading, counts,
  and read-only panels. After a successful save the form keeps the submitted
  values, because that is what the gateway now holds. To pick up a change made
  elsewhere, leave and reopen the resource. A failed refetch with retained data
  keeps the form and shows a retry notice. A failed supplementary membership
  read disables the plugin picker without changing its selections. Read-only
  policy conclusions need every input to have loaded; otherwise they report
  unknown.
- **Mutations retire the caches they invalidate.** Because fields are seeded
  once, a stale cache entry is what the operator would edit. A mutation must
  therefore *remove* (`removeQueries`) the scoped detail entry of every
  resource it deleted or re-created, not just invalidate it. Mutations that
  cascade across resource types (spec import, replace, and delete, and
  `DELETE /proxies/{id}`, which also removes the proxy's plugin configs, its
  API spec row, and an orphaned hand-owned upstream) use `retireCascade()`
  (`src/hooks/retireCascade.ts`). It retires by namespace prefix, because not
  every destroyed id is known client-side, and it uses the namespace the
  mutation was issued under. A namespace **restore** retires all five detail
  kinds (proxy, upstream, consumer, plugin configuration, API spec) and their
  inactive lists in the restored namespace, and invalidates everything else.
  It does this on success, on a committed-but-not-live answer, on an unknown
  outcome, and on every server failure that does not prove the namespace
  unchanged. See [client-recovery.md](client-recovery.md).

### Horizontal scaling

Trusted-proxy mode keeps no per-user server state. Replicas are
interchangeable, and no sticky sessions or shared cache are needed. CSRF tokens
are HMAC-signed with a key derived from `FERRUM_TRUSTED_PROXY_SECRET` and bound
to the asserted subject and an expiry `FERRUM_SESSION_TTL` seconds out. Any
replica with the same secret accepts a token another replica issued, so
restarts and rollouts lose nothing.

Rotating `FERRUM_TRUSTED_PROXY_SECRET` invalidates every outstanding CSRF
token; the SPA re-fetches `/api/auth/session` and recovers on its own. Static
development mode keeps sessions in process memory and is single-process only.

All tabs of one browser share the CSRF cookie. `GET /api/auth/session` reissues
it once the token is in the last quarter of its lifetime, which replaces it for
every tab at once. So each unsafe request sends the current value of the
readable cookie named in the session response (`csrfCookie`), falls back to the
last accepted token only if the cookie cannot be read, and sends nothing while
signed out. The BFF still requires the header to equal the cookie and to be
validly signed for the subject. A refused write is never replayed.

`FERRUM_SHUTDOWN_TIMEOUT` (milliseconds, default `10000`) bounds graceful
shutdown. A drain that outlasts it exits non-zero instead of waiting for the
orchestrator's SIGKILL.

## Development: static exchange token

The default non-production mode accepts `FERRUM_BFF_AUTH_TOKEN` only at
`POST /api/auth/login`. A successful exchange creates an opaque server-side
session in an HttpOnly, `SameSite=Strict` cookie plus a non-secret CSRF value.
The token is not stored in `localStorage` or sent on later requests. Static
mode is refused when `NODE_ENV=production` unless the unsafe
`FERRUM_ALLOW_INSECURE_STATIC_AUTH=true` escape hatch is set.

`FERRUM_JWT_NAMESPACES` scopes the static principal and is required in static
mode: a comma-separated list of exact namespace names, or `*` alone for every
namespace. `*` leaves the static principal unrestricted, and its JWTs carry no
`ns` claim. Empty entries are dropped, so `tenant-a,,tenant-b` and `*,` are
accepted. Startup fails when the variable is unset, or set but naming no
namespace (empty, whitespace, or commas only). See
[Downstream JWT claims](deployment.md#downstream-jwt-claims).

The session cookie is host-scoped, so the SPA must use the same host the BFF
issued the cookie for. `localhost` and `127.0.0.1` are different hosts: a login
at `http://127.0.0.1:$PORT` is not sent to `http://localhost:$VITE_DEV_PORT`.
The development examples use `localhost` for both. On dual-stack hosts Vite's
`localhost` bind may resolve to `[::1]`, so `http://127.0.0.1:$VITE_DEV_PORT`
is refused. Set `VITE_DEV_HOST=127.0.0.1` to force IPv4, and use the same host
in `VITE_BFF_URL`. Binding a non-loopback address is an explicit opt-in; see
[Local Development](../README.md#local-development).

## Downstream claims

Foundry JWTs contain `iss`, `sub`, `exp`, `iat`, `nbf`, `jti`, and `role`.
`aud` is added only when configured, because Ferrum rejects an unexpected
audience. `ns` is one exact namespace string or an array of them. An
unrestricted principal (a trusted-proxy admin with no namespace header, or a
static principal configured with `*`) gets no `ns` claim. `*` is only a Foundry
configuration value and is never sent as a claim.

Tokens are cached per signing input and principal, so a configuration or
identity change never reuses an earlier token.

### Session authorization changes

When a refreshed session has a different subject, authentication mode, role,
or set of namespace grants, Foundry clears cached gateway data and remounts the
authenticated workspace, discarding query results and form state. This
includes a downgrade for the same user. Reordered or duplicated grants and
display-name changes keep the workspace. The session is refreshed every 60
seconds; the BFF and gateway still authorize every request independently.

Session results are applied in the order their requests were sent, not the
order they arrive. Each request takes a ticket when it is sent. A session read,
or any request's BFF `401`, changes the session only if nothing newer has been
accepted since that request went out (`setOnUnauthorized` passes the ticket
along). A confirmed sign-in or sign-out, or unmounting the provider, retires
every request already in flight and aborts pending session reads. As a result:

- a read that completes after sign-out cannot restore the old session;
- an older, more privileged snapshot cannot overwrite a newer reduced grant;
- an older `401` cannot clear a newer session;
- a replaced provider cannot publish a token or clear its successor's cache.

A `401` for a request sent after the current session was accepted still signs
the tab out.

### Gateway target binding

With `FERRUM_ALLOW_RUNTIME_SETTINGS=true`, an administrator can point the BFF
at another allowlisted gateway while tabs are open. The namespace header cannot
tell `demo` on gateway A from `demo` on gateway B, and query keys, editor
identities, the live-apply banner, and capability observations do not record a
gateway. So Foundry binds each page load to one **gateway target** and never
lets it cross to another:

- Every gateway-facing BFF response (`/api/proxy/*`, `/api/settings`,
  `/api/settings/status`) and every login and session response carries
  `X-Foundry-Gateway-Target`: a keyed digest of the configured admin origin
  (`server/gateway-target.ts`). It changes exactly when the destination does,
  is the same across replicas and restarts for the same gateway, and does not
  reveal the origin.
- The first target a page sees is its target for the page's lifetime
  (`src/api/gatewayTarget.ts`). Every later gateway-facing request sends it in
  the same header. The BFF compares it with the target it is about to use, in
  the same step that reads the configuration it forwards with, and refuses a
  mismatch with `409 FERRUM_BFF_GATEWAY_TARGET_CHANGED` before signing a token
  or forwarding anything. A multi-request operation therefore stays on its
  original gateway or stops: the next page of a listing, a membership plan's
  apply or rollback, the apply-status poll, a guarded write's verification
  read and `PUT`, and a draft from a tab that has not noticed the change are
  all refused.
- A settings save from a tab opened against a replaced target is refused the
  same way. The form resubmits every field it was seeded with, `adminUrl`
  included, so otherwise a stale tab saving only a timeout would silently
  revert the other administrator's change.
- A page that sees any other target (from its own settings save, the 60-second
  session check, or the `409`) **retires**. It sends no further gateway
  requests, stops live-apply monitoring, discards cached reads, and unmounts
  the workspace (editors, drafts, dialogs, and the capability provider's
  health observation) in favor of a "Gateway target changed" screen. Only a
  reload leaves it, and the reload binds the new target with nothing carried
  over. The `409` retires the page by its `code` even if an intermediary
  dropped the header, so a refused read never lands on a "try again" state
  that every retry would also fail.
- A refresh, save, or session check that reports the same target changes
  nothing, so drafts survive ordinary refreshes and other settings saves.

Runtime settings are off by default, and a disallowed origin is refused before
anything changes. A request that declares no target (for example a script
calling the BFF directly) is not bound and goes to the current target. The
target header is never forwarded to the gateway.

### Guarded-write verification policy (#542)

The initial strong-ETag requirement is an additional verification
condition within the same captured namespace, resource, and gateway target;
it changes none of the identity or authorization fences above. A guarded
replacement or deletion whose initial fresh read has no usable validator is
refused before writing. Its fixed capability explanation retains no resource
or credential data, and leaves the mounted draft and baseline intact. It does
not claim that another writer changed content and never falls back to the
seed's tag or an explicitly unguarded path. Older, database-less, or cached
reads consequently lose the guarded-write fallback that v0.5.1 and earlier
releases shipped; explicit unguarded calls and unrelated writes keep their
supported semantics. The owner's delegate adopted this policy on 2026-10-06,
#544 implements it, and v0.5.2 is the first release that ships it; see
[concurrent-edits.md](concurrent-edits.md#without-a-tag).
