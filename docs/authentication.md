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

Do not expose the BFF port directly to an untrusted network. Terminate TLS at
the identity proxy, strip every identity/proof header supplied by the client,
inject the trusted values after authentication, and firewall the BFF so only
that proxy can connect. Configure the identity proxy to disable a user and
revoke its session immediately when the identity provider does so.

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
