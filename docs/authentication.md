# Production authentication

Ferrum Foundry separates browser authentication from the JWT it mints for the
Ferrum Edge Admin API. A browser never receives the gateway signing key or a
reusable deployment-wide administrator token.

## Production: trusted identity proxy

Run Foundry behind an OIDC/OAuth2-capable reverse proxy or policy gateway. The
proxy owns the authorization-code flow, MFA, its Secure/HttpOnly user session,
account revocation, and group-to-role policy. Foundry validates a separate
high-entropy proof header on every request and translates the asserted actor,
role, and exact namespace grants into the downstream Ferrum JWT.

```bash
export NODE_ENV=production
export FERRUM_AUTH_MODE=trusted-proxy
export FERRUM_TRUSTED_PROXY_SECRET="$(openssl rand -hex 32)"
export FERRUM_ADMIN_URL=https://ferrum-admin.internal:9000
export FERRUM_JWT_SECRET="$(openssl rand -hex 32)"
export FERRUM_AUTH_LOGIN_URL=/oauth2/start
export FERRUM_AUTH_LOGOUT_URL=/oauth2/sign_out
```

The trusted proxy must remove client-supplied copies and inject these headers:

| Header | Meaning |
|---|---|
| `X-Ferrum-Auth-Secret` | Exact `FERRUM_TRUSTED_PROXY_SECRET` proof |
| `X-Forwarded-User` | Stable person/service identity used as JWT `sub` |
| `X-Ferrum-Role` | `viewer`, `operator`, or `admin` after group mapping |
| `X-Ferrum-Namespaces` | Comma-separated exact namespace grants |

Non-admin identities are rejected when the namespace header is missing. An
admin may omit it only when policy deliberately grants global administration.
Header names can be changed with `FERRUM_TRUSTED_PROXY_*_HEADER` variables.

Namespace grants constrain Ferrum operations that declare
`X-Ferrum-Namespace`; they do not turn fleet-global process/runtime APIs into
tenant APIs. TLS inventory, managed TLS material, ACME, rotation, and validation
are fleet-global, so Foundry deliberately omits the tenant header and labels the
surface accordingly. Map roles with that blast radius in mind, and restrict
fleet-global routes at the identity proxy when scoped identities must not use
them.

### Namespace binding

The namespace shown in the header selector is the namespace every gateway
request from that tab carries. Foundry enforces this with one rule: **an
operation is bound to the namespace that was active when it started, and every
request it makes carries that binding.** In practice:

- The `NamespaceProvider` in each tab owns the active namespace. A hook or
  page captures it as an immutable scope when a query or mutation starts and
  passes that scope to the API layer, which stamps `X-Ferrum-Namespace` on
  each request it sends. The HTTP client never chooses a namespace itself; a
  gateway request that reaches it without a binding (and is not a documented
  fleet-global call) is refused before it goes on the wire.
- The binding covers every request an operation makes, not just the first:
  each page of a "fetch all" listing, query retries, a plugin membership
  plan's preflight reads, association writes and compensating rollbacks, a
  namespace restore, and the apply-status poll that follows a mutation. A
  switch made after an operation has started, in this tab or any other,
  does not retarget it.
- `localStorage` (`ferrum:namespace`) stores a *preference*, not the active
  namespace. It is read once when a tab loads, so a new tab opens on the
  namespace last chosen anywhere, and it is written when the user switches.
  Foundry deliberately does not react to cross-tab `storage` events: another
  tab's switch neither changes what this tab displays nor what it sends. It
  takes effect here only on the next load. Two tabs can therefore show and
  operate on different namespaces at the same time, each consistently.
- When storage is unavailable (private browsing, a disabled or throwing
  storage accessor), the provider runs purely on in-memory state from the
  default namespace `ferrum`. The displayed namespace and the request header
  come from the same value, so they cannot diverge; only the preference is
  lost between loads.

Operators who need a hard guarantee that an identity can never write outside
one namespace should still grant exactly that namespace at the identity
proxy; the binding rule keeps the UI honest, and the BFF's grant check keeps
the gateway honest.

Do not expose the BFF port directly to an untrusted network. Terminate TLS at
the identity proxy, strip every identity/proof header supplied by the client,
inject the trusted values after authentication, and firewall the BFF so only
that proxy can connect. When the identity proxy runs on the same host, set
`FERRUM_BIND_ADDRESS` (default `0.0.0.0`) to a loopback or private interface —
for example `127.0.0.1` or `::1` — so the port is never published beyond that
proxy. Configure the identity proxy to disable a user and revoke its session
immediately when the identity provider does so.

### Horizontal scaling

Trusted-proxy mode keeps no per-user server state, so replicas are
interchangeable and no sticky sessions or shared cache are required. CSRF
tokens are HMAC-signed with a key derived from `FERRUM_TRUSTED_PROXY_SECRET`
and bound to the asserted subject plus an expiry of `FERRUM_SESSION_TTL`
seconds, so any replica configured with the same secret validates a token
another replica minted. A restart or a rollout loses nothing.

Rotating `FERRUM_TRUSTED_PROXY_SECRET` invalidates every outstanding CSRF
token; the SPA re-fetches `/api/auth/session` and recovers on its own. Static
development mode is different: it stores sessions in process memory and is
therefore single-process only.

Graceful shutdown is bounded by `FERRUM_SHUTDOWN_TIMEOUT` (milliseconds,
default `10000`), so a drain that outlasts the deadline exits non-zero instead
of waiting for the orchestrator's SIGKILL.

## Development: static exchange token

The default non-production mode accepts `FERRUM_BFF_AUTH_TOKEN` only at
`POST /api/auth/login`. A successful exchange creates an opaque server-side
session in an HttpOnly, SameSite cookie plus a non-secret CSRF value. The token
is not stored in `localStorage` or sent on later requests. Static mode is
refused when `NODE_ENV=production` unless the deliberately unsafe
`FERRUM_ALLOW_INSECURE_STATIC_AUTH=true` escape hatch is present.

## Downstream claims

Foundry JWTs contain `iss`, `sub`, `exp`, `iat`, `nbf`, `jti`, and `role`.
`aud` is emitted only when configured, because Ferrum rejects an unexpected
audience. `ns` contains one exact string or an array of exact namespace grants;
Foundry does not invent wildcard behavior. Tokens are cached by every signing
input and authenticated principal, so a configuration or identity change can
never reuse an earlier token.
