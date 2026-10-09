# Deployment guide

How to run Ferrum Foundry in production. Foundry is a React single-page app
served by a Fastify BFF (backend-for-frontend). The BFF holds the Ferrum Edge
admin signing key, mints a short-lived admin JWT per request, and proxies admin
API calls to the gateway.

Foundry is in [active buildout](../README.md#development-status): development
versions may break without an upgrade path. Foundry has no database or
migrations of its own; gateway storage belongs to Ferrum Edge.

Foundry does not authenticate people. An identity-aware reverse proxy in front
of it does. Read [Production authentication](authentication.md) first. For a
runnable version of everything below, see [`deploy/starter/`](../deploy/starter/README.md).

## 1. Topology

```
Browser
  |  HTTPS
  v
Identity-aware reverse proxy      (TLS termination, OIDC login, header injection)
  |  HTTP or HTTPS, private network
  v
Ferrum Foundry BFF                (port 8080 in the published image)
  |  HTTPS to the admin API, JWT signed per request
  v
Ferrum Edge admin API             (default port 9000)
```

The proxy owns the OIDC login, MFA, the user session, session revocation, and
the group-to-role policy. It asserts the result to Foundry in four headers.
Foundry turns the asserted actor, role, and namespace grants into the `sub`,
`role`, and `ns` claims of the downstream Ferrum JWT.

### The BFF must never be reachable except through the proxy

Anyone who can reach the BFF port and knows `FERRUM_TRUSTED_PROXY_SECRET` is a
gateway administrator. Put the BFF on a private network, firewall its port so
only the proxy can connect, and never publish it on a host users can reach.

### The proxy must strip and inject these headers

The proxy must drop any client-supplied copy of each header and set its own
value. A client that can send `X-Ferrum-Role: admin` alongside a valid proof
secret is an administrator.

| Header | Injected value |
|---|---|
| `X-Ferrum-Auth-Secret` | Exact `FERRUM_TRUSTED_PROXY_SECRET` value |
| `X-Forwarded-User` | Stable actor identity; becomes the JWT `sub` |
| `X-Ferrum-Role` | `viewer`, `operator`, or `admin` after group mapping |
| `X-Ferrum-Namespaces` | Comma-separated exact namespace grants; omitted for a global admin |

The last three names are configurable (`FERRUM_TRUSTED_PROXY_USER_HEADER`,
`FERRUM_TRUSTED_PROXY_ROLE_HEADER`, `FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER`).
`X-Ferrum-Auth-Secret` is fixed. Startup fails unless, compared
case-insensitively:

- all four names are different, so one header can never be read as two
  assertions (a namespace grant as a role, or the proof secret as the actor);
- none is a header HTTP or the BFF already uses: hop-by-hop and connection
  headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`,
  `Upgrade`, `Proxy-Connection`), credentials (`Authorization`,
  `Proxy-Authorization`, `Proxy-Authenticate`, `WWW-Authenticate`, `Cookie`,
  `Set-Cookie`), request framing and forwarding (`Host`, `Accept`,
  `Content-Type`, `Content-Length`, `If-Match`, `If-None-Match`, `Range`,
  `Prefer`, `Origin`, `Referer`, `Forwarded`, `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`), and the BFF's own
  `X-CSRF-Token`, `X-Ferrum-Namespace`, and `X-Foundry-Gateway-Target`.

Foundry answers `401` when:

- the proof secret does not match;
- any of the four headers appears more than once;
- the actor is missing, longer than 254 characters, or contains control characters;
- the role is not one of the three values;
- the namespace header is present but empty, contains `*` or a glob, or has a
  name that does not match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$`;
- a `viewer` or `operator` arrives without the namespace header.

Only an `admin` may be global, and only by omitting the namespace header. There
is no wildcard spelling. See [Production authentication](authentication.md)
for the full contract. Authentication runs in Fastify's `onRequest` hook,
before any body is parsed.

In production the BFF trusts `X-Forwarded-*` only from the directly connected
peer, so run exactly one proxy hop in front of it.

## 2. Configuration reference

`server/config.ts` reads every variable below at startup. Invalid values fail
startup instead of being coerced. Booleans accept only `true` and `false`.
Durations are integers.

### Core

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ADMIN_URL` | Yes | - | `http`/`https` origin, no path, query, fragment, or credentials. With `NODE_ENV=production`, `https` unless the host is loopback | Ferrum Edge admin API origin. See [Admin API transport](#admin-api-transport) |
| `FERRUM_JWT_SECRET` | Yes | - | 32 UTF-8 bytes or more, not blank | HS256 key for downstream admin JWTs. Must equal the gateway's `FERRUM_ADMIN_JWT_SECRET`. Used verbatim, like the gateway: surrounding whitespace is part of the key |
| `PORT` | No | `3001` (`8080` in the image) | 1-65535 | BFF listen port |
| `NODE_ENV` | No | unset (`production` in the image) | any string | `production` turns on production logging, static SPA serving, secure cookies, one-hop proxy trust, the static-auth refusal, and the plaintext admin URL refusal |
| `FERRUM_BIND_ADDRESS` | No | `0.0.0.0` | literal IPv4/IPv6 address or `localhost` | Interface the BFF listens on |

### Authentication

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_AUTH_MODE` | No | `static` | `static` or `trusted-proxy` | Browser authentication mode. `static` is refused when `NODE_ENV=production` |
| `FERRUM_TRUSTED_PROXY_SECRET` | In `trusted-proxy` | - | 32 characters or more | Value the proxy sends in `X-Ferrum-Auth-Secret` |
| `FERRUM_TRUSTED_PROXY_USER_HEADER` | No | `x-forwarded-user` | valid, unreserved HTTP header name, distinct from the other identity headers | Header carrying the actor |
| `FERRUM_TRUSTED_PROXY_ROLE_HEADER` | No | `x-ferrum-role` | valid, unreserved HTTP header name, distinct from the other identity headers | Header carrying the role |
| `FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER` | No | `x-ferrum-namespaces` | valid, unreserved HTTP header name, distinct from the other identity headers | Header carrying namespace grants |
| `FERRUM_AUTH_LOGIN_URL` | No | - | root-relative path (not `//`, no backslash) or an `https://` URL | Where the SPA sends a signed-out user |
| `FERRUM_AUTH_LOGOUT_URL` | No | - | root-relative path or an `https://` URL | Where the SPA sends a user to sign out of the proxy |
| `FERRUM_SESSION_TTL` | No | `3600` | 60-86400 seconds | Lifetime of the BFF session cookie and of a trusted-proxy CSRF token |
| `FERRUM_SECURE_COOKIES` | No | `true` when `NODE_ENV=production`, else `false` | `true`/`false` | Sets `Secure` and the `__Host-` cookie name prefix |
| `FERRUM_BFF_AUTH_TOKEN` | In `static` | - | 32 characters or more | Development-only token exchanged once at `POST /api/auth/login` |
| `FERRUM_ALLOW_INSECURE_STATIC_AUTH` | No | `false` | `true`/`false` | Allows static auth under `NODE_ENV=production`. Do not use it |

### Downstream JWT claims

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_JWT_ISSUER` | No | `ferrum-edge` | non-empty string | `iss` claim |
| `FERRUM_JWT_TTL` | No | `900` | 1-86400 seconds, at most `FERRUM_JWT_MAX_TTL` | Lifetime of each minted JWT |
| `FERRUM_JWT_MAX_TTL` | No | `3600` | 0-86400 seconds; `0` disables the ceiling | Gateway maximum TTL that `FERRUM_JWT_TTL` is checked against |
| `FERRUM_JWT_ROLE` | No | `admin` | `viewer`, `operator`, or `admin` | Role of the static development principal. Trusted-proxy requests take the role from the header |
| `FERRUM_JWT_AUDIENCE` | No | - | comma-separated exact values | `aud` claim, sent only when set. Must match the gateway's `FERRUM_ADMIN_JWT_AUDIENCE` |
| `FERRUM_JWT_NAMESPACES` | In `static` | - | comma-separated names matching `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$`, or `*` alone | `ns` grants for the static principal and the readiness probe. `*` grants every namespace and omits `ns`. Exact names make every static session namespace-scoped, so no session can change BFF settings at runtime; change them here and restart. A scoped session cannot use fleet-wide surfaces, and with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` on Edge an unrestricted (`*`) session cannot use namespace routes, so operators who need both need two identities ([details](authentication.md#one-identity-cannot-do-both)) |

`FERRUM_JWT_NAMESPACES` rules:

- Whitespace around entries is allowed, duplicates merge, and empty entries are
  dropped (`tenant-a,,tenant-b` is `tenant-a,tenant-b`; `*,` is `*`).
- Only `*` on its own grants every namespace.
- `static` mode refuses to start while it is unset. Set `*` for an
  unrestricted static principal (no `ns` claim).
- A value that names no namespace (empty, whitespace, or commas only), an
  invalid name, or `*` mixed with names fails startup.
- In `trusted-proxy` mode the proxy supplies each user's grants. This variable
  only scopes the readiness probe, which reads fleet-global endpoints, so it
  can be left unset there.

### Gateway transport

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ALLOW_INSECURE_ADMIN_HTTP` | No | `false` | `true`/`false` | Under `NODE_ENV=production`, allows a plaintext `http://` admin origin on a host other than loopback and disables the production refusal of `FERRUM_TLS_VERIFY=false` for remote admin URLs. Only for a disposable, isolated stack such as the starter's demo profile. Never for a real gateway |
| `FERRUM_TLS_CA_PATH` | No | - | PEM file, 1 byte to 1 MiB, regular file inside the CA root | Extra trust anchors for an `https` admin API |
| `FERRUM_TLS_CA_ROOT` | No | directory of `FERRUM_TLS_CA_PATH` | directory path | Root the CA bundle path must resolve inside. Symlinks that stay inside it (such as Kubernetes projected volumes) are allowed |
| `FERRUM_TLS_VERIFY` | No | `true` | `true`/`false` | Verify the admin API certificate. Production refuses `false` for a remote admin URL unless `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` |
| `FERRUM_CONNECT_TIMEOUT` | No | `5000` | 100-300000 ms | TCP/TLS connect timeout to the admin API |
| `FERRUM_READ_TIMEOUT` | No | `60000` | 100-3600000 ms | Response deadline. Backup and restore get at least 120 s; see [waiting routes](#live-apply-monitoring-and-acme-issuance-deadlines) |
| `FERRUM_WRITE_TIMEOUT` | No | `60000` | 100-3600000 ms | Longest idle gap between request body chunks, and the whole-body deadline on ordinary (2 MiB) routes |
| `FERRUM_UPLOAD_TIMEOUT` | No | `300000` | 1000-3600000 ms | Whole-body deadline for restore and API-spec uploads. Progress never extends it |
| `FERRUM_MAX_LARGE_UPLOADS` | No | `2` | 1-32, at most `FERRUM_MAX_ACTIVE_UPLOADS` | Concurrent restore and API-spec uploads before `429` |
| `FERRUM_MAX_ACTIVE_UPLOADS` | No | `32` | 1-1024 | Concurrent proxied requests with a body, of any size, before `429` |
| `FERRUM_MAX_ACTIVE_LONG_READS` | No | `32` | 1-1024 | Concurrent [long-running reads](#long-running-reads) (apply-status long polls, backup downloads, namespace-scoped namespace lists) before `429` |
| `FERRUM_MAX_LONG_READS_PER_PRINCIPAL` | No | `8` | 1-1024, at most `FERRUM_MAX_ACTIVE_LONG_READS` | Long-running reads one authenticated subject may hold at once before `429` |
| `FERRUM_NAMESPACE_SCAN_MAX_PAGES` | No | `50` | 1-1000 | Upstream pages of 1000 names a namespace-scoped `GET /namespaces` may read before it answers `503` |
| `FERRUM_MAX_GATEWAY_CONNECTIONS` | No | `FERRUM_MAX_ACTIVE_LONG_READS` + `FERRUM_MAX_ACTIVE_UPLOADS` + 64 (`128`) | 1-4096, at least `FERRUM_MAX_ACTIVE_LONG_READS` + `FERRUM_MAX_ACTIVE_UPLOADS` + 16 | Connections the BFF opens to the admin API for proxied and settings traffic; see [gateway connections](#gateway-connections) |

A CA bundle must hold one or more parseable PEM X.509 certificates (blank and
`#` comment lines are allowed). Parsing checks the encoding, not whether the
bundle actually trusts the gateway.

#### Admin API transport

Every request the BFF sends to the admin API carries a signed admin JWT in
`Authorization`. Over plaintext to another host, anyone on the path could
replay that token or alter the gateway's answers. So with
`NODE_ENV=production`, startup fails unless `FERRUM_ADMIN_URL` and every
`FERRUM_ADMIN_ALLOWED_ORIGINS` entry either:

- uses `https`; or
- uses `http` to a loopback address: exact `localhost`, an IPv4 literal in
  `127.0.0.0/8`, or `::1`. A hostname is never loopback because of how it is
  spelled, so `127.0.0.1.example.com` is remote.

A runtime `adminUrl` change follows the same rule and is refused with
`400 FERRUM_BFF_INVALID_SETTINGS`. `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true`
lifts the rule, for a disposable stack whose gateway is reachable only on an
isolated network. The same override also permits `FERRUM_TLS_VERIFY=false` for
a remote admin URL in production; without it, startup and runtime settings
reject that combination. Keep TLS verification enabled for real gateways.

Ferrum Edge also uses the environment variable
`FERRUM_ALLOW_INSECURE_ADMIN_HTTP` to allow its own plaintext admin listener.
If Foundry and Edge consume the same env file or ConfigMap, setting the Edge
variable also disables Foundry's production transport checks. Keep the two
deployments' settings separate, or use the shared value only for a disposable,
isolated demo stack. Outside production (`npm run dev`), Foundry's production
checks are not applied.

### Browser security

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ENABLE_HSTS` | No | `false` | `true`/`false` | Sends `Strict-Transport-Security` with a one-year max-age and `includeSubDomains` |

### Runtime settings

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ALLOW_RUNTIME_SETTINGS` | No | `false` | `true`/`false` | Lets admins change an allowlist of connection settings from the UI |
| `FERRUM_ADMIN_ALLOWED_ORIGINS` | When runtime settings are on | - | comma-separated `http`/`https` origins; `https` or loopback in production, like `FERRUM_ADMIN_URL` | Origins a runtime `adminUrl` change may select |
| `FERRUM_ADMIN_ALLOWED_CIDRS` | No | - | comma-separated CIDRs | Private or special-purpose ranges a changed admin URL may resolve to |

Leave runtime settings off. When they are on, any `admin` can repoint the whole
BFF process at another allowlisted gateway. Overrides live in memory and reset
to the environment on restart.

When runtime settings are on:

- The startup `FERRUM_ADMIN_URL` is always permitted. Any other origin must be
  in `FERRUM_ADMIN_ALLOWED_ORIGINS`, and its addresses (checked at DNS
  resolution for hostnames) must not be private or special-purpose unless
  `FERRUM_ADMIN_ALLOWED_CIDRS` allows them.
- CIDRs need a literal address and an explicit decimal prefix (`0`-`32` for
  IPv4, `0`-`128` for IPv6; no signs or leading zeros). `/0` allows a whole
  address family. IPv4-mapped, IPv4-compatible, NAT64 (`64:ff9b::/96`), and
  6to4 (`2002::/16`) addresses are judged by the IPv4 address they embed.
- A runtime CA path change needs a CA root (`FERRUM_TLS_CA_ROOT`, or the one
  implied by `FERRUM_TLS_CA_PATH`).
- `PUT /api/settings` answers `403 FERRUM_BFF_SETTINGS_IMMUTABLE` when runtime
  settings are off, and `400 FERRUM_BFF_INVALID_SETTINGS` for any invalid
  field, applying nothing. An omitted field keeps its value; send
  `jwtAudience: ""` (or `[]`) to drop the `aud` claim.
- In `trusted-proxy` mode, `jwtRole` and `jwtNamespaces` are refused with
  `400 FERRUM_BFF_PROXY_MANAGED_IDENTITY`. The rest of the namespace-default
  rules are in [Runtime identity defaults](authentication.md#runtime-identity-defaults).
- Changing `adminUrl` changes the gateway every open tab works against. Each
  tab stays bound to the gateway it loaded against: its later requests get
  `409 FERRUM_BFF_GATEWAY_TARGET_CHANGED`, and it drops its cached data and
  asks for a reload. See [Gateway target binding](authentication.md#gateway-target-binding).

Accepted changes apply to new requests. A connection change (origin, connect
timeout, TLS verification, CA, allowed CIDRs) opens a new connection pool while
the old one finishes the requests already on it.

### Process lifecycle

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_SHUTDOWN_TIMEOUT` | No | `10000` | 1000-300000 ms | How long `SIGTERM`/`SIGINT` waits for in-flight requests before the process exits non-zero |

## 3. Reverse proxy example (nginx and oauth2-proxy)

The starter ships a working nginx + oauth2-proxy setup. Copy it rather than
writing your own:

| File | What it does |
|---|---|
| [`deploy/starter/nginx/foundry.conf`](../deploy/starter/nginx/foundry.conf) | Terminates TLS, runs `auth_request` against oauth2-proxy, proxies to the BFF |
| [`deploy/starter/nginx/identity/policy.conf`](../deploy/starter/nginx/identity/policy.conf) | Group-to-role and group-to-namespace `map` blocks (`http` context) |
| [`deploy/starter/nginx/identity/inject.conf`](../deploy/starter/nginx/identity/inject.conf) | The four `proxy_set_header` lines, with the proof secret read from `secrets/ferrum-proxy-secret.conf` |
| [`deploy/starter/compose.yaml`](../deploy/starter/compose.yaml) | oauth2-proxy flags (`--set-xauthrequest`, `--reverse-proxy`, `--allowed-group=...`) |

Point the SPA's sign-in and sign-out actions at the proxy:

```bash
FERRUM_AUTH_LOGIN_URL=/oauth2/start
FERRUM_AUTH_LOGOUT_URL=/oauth2/sign_out
```

Things that are easy to get wrong:

- **Keep all four `proxy_set_header` lines**, even when a value is empty.
  `proxy_set_header` replaces a client's copy of the header; any header you do
  not set is forwarded from the client as-is. nginx drops a header whose value
  is empty, so an identity mapped to no namespaces arrives without the header
  rather than with an empty one.
- **Deny by default.** The `map` default is empty, so an unmapped user gets no
  role and Foundry answers `401` with `x-ferrum-auth-layer: bff`. oauth2-proxy's
  `--allowed-group` also refuses such a user at login.
- **Use exact namespace names.** Foundry expands no wildcards or prefixes. Do
  not map a global admin to `*`; omit the header for that identity instead.
- **Keep `map` in the `http` context and never gate on `$ferrum_role` with
  `if`.** `if` runs before the auth subrequest, so it always sees an empty
  value. The mapped variables resolve later, when `proxy_set_header` uses them.
- **Keep the `/api/` split in `@signin`.** The SPA calls `/api/auth/session`
  on load and every minute, and needs a raw `401` when the proxy session is
  gone. A redirect or HTML page there shows a session error instead of the
  sign-in button:

  ```nginx
  location @signin {
      if ($request_uri ~ ^/api/) {
          return 401;
      }
      return 302 /oauth2/start?rd=$request_uri;
  }
  ```

- **Size for large uploads.** Restores can reach 110 MiB and API-spec imports
  30 MiB, so set `client_max_body_size 110m`. With
  `proxy_request_buffering off`, keep `client_body_timeout` and
  `proxy_read_timeout` at or below Foundry's own budgets
  (`FERRUM_UPLOAD_TIMEOUT`, and `FERRUM_WRITE_TIMEOUT` for ordinary routes).
- **Fleet-global surfaces are not namespace-scoped, and a scoped identity is
  bounded to namespace-scoped routes.** TLS inventory, managed TLS material,
  ACME, rotation, and validation ignore namespace grants, so a scoped identity
  may use none of them, reads included. More broadly, a session with namespace
  grants may reach only the gateway routes its namespace scopes, plus a small
  fleet-wide ceiling, the same routes Ferrum Edge v0.9.16+ serves to the
  `ns`-claim JWT Foundry signs for it. `/health` and `/status` answer it with a
  summary (`status`, `timestamp`, `mode`, `admin_writes_enabled`, `ready`, and
  the `namespace` serving block when it names a granted namespace) rather than
  the detailed view. `/admin/tls/*`, `/overload`, `/cluster`,
  `/config/apply-status`, `/mesh/*`, `/charges`, `/metrics`,
  `/backend-capabilities`, and unknown routes are refused with `403`, so such a
  session loses the Dashboard, Metrics, TLS, Cluster, and Mesh surfaces in the
  UI and lands on Proxies. It may not change BFF settings either:
  `PUT /api/settings` answers it `403 FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED`.
  The audit log stays available for the session's own namespaces. Edge records
  fleet-wide actions under its default `ferrum` namespace, so an identity
  granted `ferrum` reads those rows. Only an identity that omits the namespaces
  header (an unrestricted admin) sees the fleet-wide surfaces. The starter maps
  every group, `ferrum-admins` included, to a namespace, so every starter user
  is scoped; see [Authentication](authentication.md#namespace-route-ceiling).
- **Cap in-flight API requests per client.** The starter allows 64 `/api/`
  requests in flight per client address (`limit_conn foundry_api 64`, answered
  with `429`). nginx applies it before `auth_request`, so it is keyed on the
  address, not the identity; Foundry bounds each identity itself (see
  [long-running reads](#long-running-reads)). Match on the decoded `$uri`,
  not `$request_uri`, or a percent-encoded `/%61pi/` prefix escapes the count.
  Raise the limit if many users share one address, such as behind a corporate
  NAT.

### Live-apply monitoring and ACME issuance deadlines

Some admin calls wait on the gateway. The BFF gives them longer deadlines than
`FERRUM_READ_TIMEOUT`, and the browser allows a little more:

| Call | BFF deadline | Browser deadline |
|---|---|---|
| Config apply-status long poll (25 s wait) | at least 35 s | 30 s |
| ACME order finalize | at least 610 s | requested polling budget + 5 s |
| API-spec import or replace | `FERRUM_UPLOAD_TIMEOUT`, then `FERRUM_READ_TIMEOUT` | 365 s |
| API-spec read or document download | `FERRUM_READ_TIMEOUT` | 65 s |
| ACME order create or renew | `FERRUM_WRITE_TIMEOUT`, then `FERRUM_READ_TIMEOUT` | 125 s |

The ACME polling budget defaults to 60 s and must be 1-600 s. The browser
figures use the shipped BFF defaults; it cannot see runtime overrides, so a
deployment with larger budgets can outlast them. None of these calls retry
automatically.

Give any outer proxy or load balancer at least 35 s for apply-status and 610 s
for ACME finalize. The starter's 180 s `proxy_read_timeout` is too short for a
finalize that requests more than 175 s. A shorter infrastructure timeout can
cut the response off; it does not stop the gateway from issuing.

When a finalize times out, disconnects, or gets a server error, Foundry shows
it as **in progress / unknown** and replaces Finalize with **Re-check status**,
which reads the order without repeating the POST. Keep checking until the
gateway reports a terminal state.

An interrupted spec import or replacement, or an ACME create or renew, shows
**outcome unknown** and blocks resubmission in that view. Inspect the spec
resources or ACME orders before you reload or retry; the warning does not
survive a page load. Only a BFF timeout with `phase: "upload"` proves the
request never reached the gateway. A response-phase timeout, bare `504`,
network error, or upstream `5xx` does not prove nothing was created.

## 4. Docker Compose example

[`deploy/starter/compose.yaml`](../deploy/starter/compose.yaml) is the
Compose version of this topology, with third-party images pinned by digest.
Its `production` profile runs Foundry, oauth2-proxy, and nginx against your
own gateway; see the [starter README](../deploy/starter/README.md#production)
for setup. What it gets right:

- The `foundry` service publishes no host port. Only the proxy does.
- Secrets are split. `.env` holds `FERRUM_JWT_SECRET` and
  `FERRUM_TRUSTED_PROXY_SECRET`; `oauth2-proxy.env` holds the
  `OAUTH2_PROXY_*` settings. `foundry` has no `env_file`, so the OAuth client
  secret never reaches the BFF, and oauth2-proxy never sees the gateway key or
  the proof secret. Keep both files `chmod 600` and out of version control.

The image's `HEALTHCHECK` requests `/api/health/live` on the container's
`PORT`. It deliberately does not use readiness, so a gateway outage does not
make Docker restart Foundry.

## 5. Kubernetes example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ferrum-foundry
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ferrum-foundry
  template:
    metadata:
      labels:
        app: ferrum-foundry
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: foundry
          image: ferrumedge/ferrum-foundry:vX.Y.Z
          ports:
            - name: http
              containerPort: 8080
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          env:
            - name: NODE_ENV
              value: production
            - name: FERRUM_ADMIN_URL
              value: https://ferrum-edge-admin.ferrum.svc.cluster.local:9000
            - name: FERRUM_AUTH_MODE
              value: trusted-proxy
            - name: FERRUM_AUTH_LOGIN_URL
              value: /oauth2/start
            - name: FERRUM_AUTH_LOGOUT_URL
              value: /oauth2/sign_out
            - name: FERRUM_JWT_AUDIENCE
              value: ferrum-admin
            - name: FERRUM_ENABLE_HSTS
              value: "true"
            - name: FERRUM_SHUTDOWN_TIMEOUT
              value: "10000"
            - name: FERRUM_TLS_CA_ROOT
              value: /etc/ferrum/ca
            - name: FERRUM_TLS_CA_PATH
              value: /etc/ferrum/ca/gateway-ca.pem
            - name: FERRUM_JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: ferrum-foundry
                  key: jwt-secret
            - name: FERRUM_TRUSTED_PROXY_SECRET
              valueFrom:
                secretKeyRef:
                  name: ferrum-foundry
                  key: trusted-proxy-secret
          volumeMounts:
            - name: gateway-ca
              mountPath: /etc/ferrum/ca
              readOnly: true
          livenessProbe:
            httpGet:
              path: /api/health/live
              port: http
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/health/ready
              port: http
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 100m
              memory: 192Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: gateway-ca
          secret:
            secretName: ferrum-gateway-ca
---
apiVersion: v1
kind: Service
metadata:
  name: ferrum-foundry
spec:
  type: ClusterIP
  selector:
    app: ferrum-foundry
  ports:
    - name: http
      port: 8080
      targetPort: http
```

Notes:

- The Service is `ClusterIP` on purpose. Do not expose it through a
  `LoadBalancer`, `NodePort`, or an Ingress rule that skips the identity proxy.
  Whatever sits in front must do the OIDC login and strip and inject the four
  identity headers. Enforce this with a `NetworkPolicy` that admits only the
  proxy's pods.
- `FERRUM_TLS_CA_PATH` points into the Secret mount and `FERRUM_TLS_CA_ROOT`
  at the mount directory. Kubernetes rotates Secret files through a `..data`
  symlink; the BFF follows it inside the root and picks up the rotated bundle.
- `terminationGracePeriodSeconds` must exceed `FERRUM_SHUTDOWN_TIMEOUT`, so the
  process finishes its own drain before the kubelet sends `SIGKILL`.
- Trusted-proxy mode keeps no per-user server state, so replicas need no sticky
  sessions ([Horizontal scaling](authentication.md#horizontal-scaling)).
  Static mode keeps sessions in process memory and is single-replica,
  development only.
- `readOnlyRootFilesystem: true` works because the BFF writes nothing to disk.

## 6. Health, logging, and operations

### Health endpoints

| Path | Meaning |
|---|---|
| `GET /api/health/live` | Liveness. `200` with `{"status":"ok","version":"..."}` while the process serves requests. Never calls the gateway |
| `GET /api/health/ready` | Readiness. Probes the gateway and reports the result |
| `GET /api/health` | Same as `/api/health/live` |

Readiness signs a `viewer` JWT (scoped by `FERRUM_JWT_NAMESPACES`) and makes
two gateway calls: `GET /health`, then `GET /namespaces?offset=0&limit=1` to
prove the gateway accepts the JWT. `/namespaces` is authenticated but
fleet-global, so the probe needs no tenant. Results are cached for 5 seconds
and concurrent probes share one check, so a short probe interval does not
multiply gateway load.

It returns `200` with `status` `ready` or `degraded` when both calls succeed,
and `503` with `status: "unavailable"` when the gateway is unreachable,
unhealthy, or rejects the JWT. Wire it as the readiness probe so a gateway
outage or signing-key mismatch takes Foundry out of rotation.

The UI header polls readiness every 15 seconds. It shows **Connected** for
`ready`, **Degraded** for `degraded`, **Disconnected** for `unavailable`, and
**Unreachable** when the readiness request itself fails, even if an earlier
check succeeded.

All three endpoints are unauthenticated. Liveness carries no gateway detail;
readiness reports only component status, the gateway HTTP status, and the
Foundry version.

### Logging

Logs are pino JSON on stdout, at `info` when `NODE_ENV=production` and `debug`
otherwise. The BFF writes no log files.

The BFF never logs the CA bundle, `FERRUM_JWT_SECRET`,
`FERRUM_TRUSTED_PROXY_SECRET`, `FERRUM_BFF_AUTH_TOKEN`, or a minted JWT.
Runtime settings changes are logged with the actor and each changed field;
`adminUrl` and `tlsCaPath` values are redacted.

API responses carry `cache-control: no-store`. Hashed static assets are cached
for a year; `index.html` and `theme-bootstrap.js` are never cached.

### Upload bounds

Body size limits per proxied route: 110 MiB for restore, 30 MiB for API specs,
2 MiB for everything else. A larger declared `content-length` gets `413`.

Time limits:

- `FERRUM_WRITE_TIMEOUT` bounds the idle gap between chunks.
- `FERRUM_UPLOAD_TIMEOUT` bounds the whole restore or API-spec body. Ordinary
  routes use `FERRUM_WRITE_TIMEOUT` for both.
- Either limit answers `504` with `code: FERRUM_BFF_TIMEOUT`,
  `phase: "upload"`, and `reason` `idle` or `deadline`.
- As a backstop, the HTTP server closes any request still arriving 5 seconds
  after `FERRUM_UPLOAD_TIMEOUT`.

Concurrency limits: `FERRUM_MAX_ACTIVE_UPLOADS` covers every proxied request
with a body, and `FERRUM_MAX_LARGE_UPLOADS` is a tighter limit on restore and
API-spec uploads. Both answer `429` with `code: FERRUM_BFF_UPLOAD_CAPACITY`,
`retry-after: 1`, and `scope` `all` or `large`. Steady `429`s with
`scope: "all"` mean the instance is at its ceiling; raise it only with matching
socket and memory headroom.

When the BFF answers before a body has fully arrived (for example a `401`,
`403`, `413`, or capacity `429`, or a gateway that refused the upload unread),
it discards the rest of the body so the client still receives the response and
the keep-alive connection stays usable. That drain is bounded:

- by the request's remaining upload budget or 5 seconds, whichever is first,
  and by `FERRUM_WRITE_TIMEOUT` between chunks;
- to 1 more second once it has discarded 4 MiB, or from the start if the
  request declared more than 4 MiB;
- to 1 second, from a separate pool of 8 slots (or
  `FERRUM_MAX_ACTIVE_UPLOADS` if lower), for requests with no authenticated
  principal, so anonymous senders cannot crowd out signed-in drains.

A drain that hits its bound, finds its pool full, or is running when shutdown
starts closes the connection. A request that failed its own upload deadline is
closed without draining. A client still sending when its connection closes sees
`EPIPE` or `ECONNRESET`, and may lose the response if it reads only after
sending.

Drains do not count against the upload pools, so one instance can hold up to
twice `FERRUM_MAX_ACTIVE_UPLOADS`, plus the signed-out drain slots, of
body-bearing proxied sockets. Non-proxy routes (sign-in, runtime settings) are
bounded only by the server's request timeout. Size file-descriptor headroom for
this and cap connections per client at the proxy (for example nginx
`limit_conn`).

### Long-running reads

Reads carry no body, so they never enter the upload pools. Three kinds hold a
request and a gateway connection far longer than an ordinary read, or fan out
into many gateway reads, so they share a separate pool:

- the config apply-status long poll (`GET` or `HEAD /config/apply-status`),
- backup downloads (`GET` or `HEAD /backup`),
- a `GET /namespaces` from an identity with namespace grants (see below).

`FERRUM_MAX_ACTIVE_LONG_READS` bounds them for the whole instance, and
`FERRUM_MAX_LONG_READS_PER_PRINCIPAL` bounds how many of them one
authenticated subject may hold, so a single identity cannot take the whole
pool. Neither queues: a full pool answers `429` with
`code: FERRUM_BFF_READ_CAPACITY`, `retry-after: 1`, and `scope` `principal` or
`all`, before a token is signed or the gateway is contacted. The SPA retries a
refused namespace list up to twice; a refused backup read is not retried. Its
apply-status poll waits
as `Retry-After` asks, doubling the wait up to 8 s, for up to four refusals
before it counts one as a failure; after that it reports the write's live
state as unverifiable. A permit is returned when the response completes, the
request is aborted, or the client disconnects. In static mode every user is
the same subject, so all of them together get one per-subject share.

A namespace-scoped `GET /namespaces` must not reveal names outside the
identity's grants, so the BFF reads the gateway's registry in pages of 1000
names, keeps only granted names, and paginates those itself. That read is
bounded:

- it stops as soon as every granted name has been found;
- it reads at most `FERRUM_NAMESPACE_SCAN_MAX_PAGES` pages (50,000 names by
  default). A registry too large to rule out every grant within that budget
  answers `503` with `code: FERRUM_BFF_NAMESPACE_SCAN_BUDGET`, never a partial
  list. Raise the budget for a fleet that large, or give the identity exact
  grants that exist;
- identical lists in flight at the same time (same identity, grants, and
  query apart from `offset` and `limit`) share one read. Nothing is cached
  after it finishes;
- it runs under the response deadline (`FERRUM_READ_TIMEOUT`), answering
  `504` with `code: FERRUM_BFF_TIMEOUT` when that runs out.

An identity without grants gets the gateway's own paginated answer, one
gateway read per request.

### Gateway connections

Every proxied request and settings check shares one connection pool to the
admin API, capped at `FERRUM_MAX_GATEWAY_CONNECTIONS`. The cap bounds sockets
to the gateway whatever the route or how slowly a client reads its response;
a reader that stalls holds its connection only until the response deadline
(`FERRUM_READ_TIMEOUT`, or 120 s for a backup download). A request that finds
every connection busy waits for one within its own deadline, and answers `504`
if none frees up in time. Over HTTP/1.1 each request holds a socket; when the
gateway negotiates HTTP/2, the cap limits sockets and each socket carries many
requests.

The cap is shared by every user. Without a buffering proxy in front of
Foundry, one viewer holding about `FERRUM_MAX_GATEWAY_CONNECTIONS` slow
downloads of large responses can occupy it until those deadlines expire, and
other requests wait and may answer `504`. The starter's nginx buffers
responses by default, which releases the gateway connection as soon as the
response is read from the gateway; keep response buffering on in production
proxies.

The cap must exceed the two pools that refuse instead of waiting, long reads
and uploads, by at least 16 connections. The default leaves 64, so ordinary
reads still reach the gateway while both pools are full. Raise it with the
pools; the gateway must accept that many admin connections from each Foundry
replica.

The readiness probe has its own connections (4), so a saturated pool cannot
queue it and take the instance out of rotation. Replacing the transport with a
runtime settings change briefly doubles the ceiling while the old connections
drain.

### Graceful shutdown

On `SIGTERM` or `SIGINT` the BFF stops accepting connections, waits for
in-flight requests, and closes its gateway connection pool. If requests are
still running after `FERRUM_SHUTDOWN_TIMEOUT`, it exits non-zero instead of
hanging. Set the orchestrator's grace period above this value.

### Upgrade and rollback

Published image tags:

| Tag | Moves? | Use |
|---|---|---|
| `vX.Y.Z` | Never | Production deployments |
| `X.Y.Z` | Never | Same release, without the `v` |
| `X.Y` | Yes, to the newest patch | Tracking a minor line |
| `latest` | Yes, to the newest stable release | Convenience only |
| `main-<commit>` | Never | Staging a specific `main` build |
| `main` | Yes | Tracking `main`, non-production only |

Deploy an immutable tag. Pin by digest when you need byte-identical rollouts:

```bash
docker pull ferrumedge/ferrum-foundry:vX.Y.Z
docker image inspect --format '{{index .RepoDigests 0}}' ferrumedge/ferrum-foundry:vX.Y.Z
```

Roll back by redeploying the previous tag or digest. Foundry keeps no state of
its own, so a rollback is just a container replacement. If the gateway also
changed, first confirm the older Foundry still matches its admin API,
`FERRUM_JWT_AUDIENCE`, and `FERRUM_JWT_SECRET`.

Images are built for `linux/amd64` and `linux/arm64` and carry provenance and
SBOM attestations. See [Release and supply-chain gates](release-security.md).

## 7. Production checklist

- [ ] TLS terminates at the identity-aware proxy, with a current certificate.
- [ ] The proxy strips client copies of `X-Ferrum-Auth-Secret`,
      `X-Forwarded-User`, `X-Ferrum-Role`, and `X-Ferrum-Namespaces` and sets
      its own values for all four.
- [ ] Group-to-role mapping denies by default, so an unmapped user gets no role.
- [ ] Every non-admin identity receives an exact `X-Ferrum-Namespaces` list.
- [ ] `FERRUM_JWT_SECRET` and `FERRUM_TRUSTED_PROXY_SECRET` are at least 32
      characters, generated from a CSPRNG, kept in a secret store, and rotated
      on a schedule.
- [ ] `FERRUM_JWT_SECRET` matches the gateway's `FERRUM_ADMIN_JWT_SECRET`.
- [ ] `NODE_ENV=production` is set.
- [ ] `FERRUM_AUTH_MODE=trusted-proxy` is set and
      `FERRUM_ALLOW_INSECURE_STATIC_AUTH` is unset.
- [ ] `FERRUM_BFF_AUTH_TOKEN` is not in the production environment.
- [ ] Only the proxy can reach the BFF port, enforced by firewall, network
      policy, or private network.
- [ ] `FERRUM_ADMIN_URL` uses `https`, and `FERRUM_TLS_CA_PATH` plus
      `FERRUM_TLS_CA_ROOT` are set when the gateway uses a private CA.
- [ ] `FERRUM_ALLOW_INSECURE_ADMIN_HTTP` is unset or `false`.
- [ ] `FERRUM_TLS_VERIFY` is left at `true`.
- [ ] `FERRUM_ALLOW_RUNTIME_SETTINGS` is left at `false`.
- [ ] `FERRUM_ENABLE_HSTS=true` only when this host and all its subdomains are
      served over HTTPS only.
- [ ] `FERRUM_JWT_AUDIENCE` matches the gateway's `FERRUM_ADMIN_JWT_AUDIENCE`,
      or both are unset.
- [ ] `FERRUM_AUTH_LOGIN_URL` and `FERRUM_AUTH_LOGOUT_URL` point at the proxy's
      real sign-in and sign-out endpoints.
- [ ] Readiness is probed at `/api/health/ready` and liveness at
      `/api/health/live`.
- [ ] The orchestrator grace period exceeds `FERRUM_SHUTDOWN_TIMEOUT`.
- [ ] Container stdout goes to a log pipeline and is retained.
- [ ] The deployed image is an immutable `vX.Y.Z` tag or a digest.
