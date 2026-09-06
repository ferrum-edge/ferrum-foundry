# Deployment guide

This guide covers running Ferrum Foundry in production. Foundry is a React
single-page application served by a Fastify BFF (backend-for-frontend). The BFF
holds the Ferrum Edge admin signing key, mints short-lived admin JWTs, and
proxies admin API calls to the gateway.

Foundry does not authenticate people. An identity-aware reverse proxy in front
of it does. Read [Production authentication](authentication.md) before
deploying.

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

The proxy owns the OIDC authorization-code flow, multi-factor authentication,
the user session cookie, session revocation, and the group-to-role policy. It
asserts the result to Foundry with four headers. Foundry translates the asserted
actor, role, and namespace grants into the `sub`, `role`, and `ns` claims of the
downstream Ferrum JWT.

### The BFF must never be reachable except through the proxy

Anyone who can reach the BFF port and knows `FERRUM_TRUSTED_PROXY_SECRET` is a
gateway administrator. Bind the BFF to a private interface, put it on a private
network or namespace, and firewall the port so only the proxy can connect. Do
not publish the BFF port on a host that is reachable from a user network.

### The proxy must strip and inject these headers

The proxy must remove any client-supplied copy of each header below and set its
own trusted value. A client that can set `X-Ferrum-Role: admin` on a request
that already carries a valid proof secret is an administrator.

| Header | Injected value |
|---|---|
| `X-Ferrum-Auth-Secret` | Exact `FERRUM_TRUSTED_PROXY_SECRET` value |
| `X-Forwarded-User` | Stable actor identity, becomes the JWT `sub` |
| `X-Ferrum-Role` | `viewer`, `operator`, or `admin` after group mapping |
| `X-Ferrum-Namespaces` | Comma-separated exact namespace grants |

The header names are configurable for the last three
(`FERRUM_TRUSTED_PROXY_USER_HEADER`, `FERRUM_TRUSTED_PROXY_ROLE_HEADER`,
`FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER`). The proof header name
`X-Ferrum-Auth-Secret` is fixed.

Foundry rejects a request when the proof secret does not match, when the actor
is missing or contains control characters, when the role is not one of the three
values, or when a non-admin role arrives without namespace grants.
Authentication runs in Fastify's `onRequest` hook, before any body parsing.

In production the BFF sets Fastify `trustProxy` to 1, so it trusts exactly one
hop of `X-Forwarded-*`. Run exactly one proxy directly in front of it.

## 2. Configuration reference

Every variable below is read by `server/config.ts` at startup. Invalid values
fail startup rather than being coerced. Boolean variables accept only the exact
strings `true` and `false`. Duration variables are integers.

### Core

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ADMIN_URL` | Yes | - | `http`/`https` origin, no path, query, fragment, or credentials | Ferrum Edge admin API origin |
| `FERRUM_JWT_SECRET` | Yes | - | 32 characters or more | HS256 key for downstream admin JWTs; must equal the gateway's `FERRUM_ADMIN_JWT_SECRET` |
| `PORT` | No | `3001` (`8080` in the image) | 1-65535 | TCP port the BFF listens on |
| `NODE_ENV` | No | unset (`production` in the image) | any string | `production` enables production logging, static SPA serving, secure cookies, one-hop proxy trust, and the static-auth refusal |
| `FERRUM_BIND_ADDRESS` | No | `0.0.0.0` | literal IPv4/IPv6 address or `localhost` | Interface the BFF listens on |

### Authentication

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_AUTH_MODE` | No | `static` | `static` or `trusted-proxy` | Browser authentication mode; `static` is refused when `NODE_ENV=production` |
| `FERRUM_TRUSTED_PROXY_SECRET` | Yes in `trusted-proxy` | - | 32 characters or more | Value the proxy must send in `X-Ferrum-Auth-Secret` |
| `FERRUM_TRUSTED_PROXY_USER_HEADER` | No | `x-forwarded-user` | valid HTTP header name, lowercased | Header carrying the asserted actor |
| `FERRUM_TRUSTED_PROXY_ROLE_HEADER` | No | `x-ferrum-role` | valid HTTP header name, lowercased | Header carrying the asserted role |
| `FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER` | No | `x-ferrum-namespaces` | valid HTTP header name, lowercased | Header carrying comma-separated namespace grants |
| `FERRUM_AUTH_LOGIN_URL` | No | - | root-relative path (not `//`, no backslash) or an `https://` URL | Where the SPA sends an unauthenticated user to sign in |
| `FERRUM_AUTH_LOGOUT_URL` | No | - | root-relative path or an `https://` URL | Where the SPA sends a user to sign out of the proxy |
| `FERRUM_SESSION_TTL` | No | `3600` | 60-86400 seconds | Lifetime of the BFF session cookie and of a trusted-proxy CSRF grant |
| `FERRUM_SECURE_COOKIES` | No | `true` when `NODE_ENV=production`, else `false` | `true`/`false` | Sets the `Secure` attribute and the `__Host-` cookie name prefix |
| `FERRUM_BFF_AUTH_TOKEN` | Yes in `static` | - | 32 characters or more | Development-only token exchanged once at `POST /api/auth/login` |
| `FERRUM_ALLOW_INSECURE_STATIC_AUTH` | No | `false` | `true`/`false` | Escape hatch that permits static auth under `NODE_ENV=production`; do not use it |

### Downstream JWT claims

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_JWT_ISSUER` | No | `ferrum-edge` | non-empty string | `iss` claim |
| `FERRUM_JWT_TTL` | No | `900` | 1-86400 seconds, must not exceed `FERRUM_JWT_MAX_TTL` | Lifetime of each minted admin JWT |
| `FERRUM_JWT_MAX_TTL` | No | `3600` | 0-86400 seconds, `0` disables the ceiling | Gateway-configured maximum TTL that `FERRUM_JWT_TTL` is validated against |
| `FERRUM_JWT_ROLE` | No | `admin` | `viewer`, `operator`, or `admin` | Role for the static development principal; trusted-proxy requests take the role from the header instead |
| `FERRUM_JWT_AUDIENCE` | No | - | comma-separated exact values | `aud` claim, emitted only when set; must match the gateway's `FERRUM_ADMIN_JWT_AUDIENCE` |
| `FERRUM_JWT_NAMESPACES` | No | - | comma-separated names matching `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$` | `ns` claim for the static principal and for the readiness probe |

### Gateway transport

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_TLS_CA_PATH` | No | - | path to a PEM file, 1 byte to 1 MiB, regular file inside the CA root | Extra trust anchors for the admin API connection |
| `FERRUM_TLS_CA_ROOT` | No | directory of `FERRUM_TLS_CA_PATH` | directory path | Approved root that a CA bundle path must resolve inside; contained projected-volume symlinks are allowed |
| `FERRUM_TLS_VERIFY` | No | `true` | `true`/`false` | Verify the admin API certificate; never set to `false` in production |
| `FERRUM_CONNECT_TIMEOUT` | No | `5000` | 100-300000 ms | TCP/TLS connect timeout to the admin API |
| `FERRUM_READ_TIMEOUT` | No | `60000` | 100-3600000 ms | Response read timeout |
| `FERRUM_WRITE_TIMEOUT` | No | `60000` | 100-3600000 ms | Request write timeout: the idle gap allowed between request body chunks, and the absolute body deadline on ordinary (2 MiB) routes |
| `FERRUM_UPLOAD_TIMEOUT` | No | `300000` | 1000-3600000 ms | Absolute wall-clock deadline for a restore or API-spec request body to finish arriving; measured from the first byte and never extended by progress |
| `FERRUM_MAX_LARGE_UPLOADS` | No | `2` | 1-32, must not exceed `FERRUM_MAX_ACTIVE_UPLOADS` | Concurrent restore and API-spec uploads before the BFF returns `429` |
| `FERRUM_MAX_ACTIVE_UPLOADS` | No | `32` | 1-1024 | Concurrent proxied requests carrying a request body, of any size, before the BFF returns `429` |

### Browser security

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ENABLE_HSTS` | No | `false` | `true`/`false` | Sends `Strict-Transport-Security` with a one-year max-age and `includeSubDomains` |

### Runtime settings

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_ALLOW_RUNTIME_SETTINGS` | No | `false` | `true`/`false` | Permits admins to change an allowlist of connection settings through the UI at runtime |
| `FERRUM_ADMIN_ALLOWED_ORIGINS` | Required when runtime settings are enabled | - | comma-separated `http`/`https` origins | Origins a runtime `adminUrl` change may select |
| `FERRUM_ADMIN_ALLOWED_CIDRS` | No | - | comma-separated CIDRs | Private or special-purpose ranges a changed admin URL may resolve to; the startup origin is always permitted |

With `FERRUM_ALLOW_RUNTIME_SETTINGS=true`, clearing **JWT Audience** and saving
removes the `aud` claim from subsequent BFF-generated JWTs. The Settings form
displays the canonical values returned by the BFF after each successful save.
For `PUT /api/settings`, an omitted field leaves its current value unchanged;
send `jwtAudience: ""` (or `[]`) to clear the audience, and `jwtNamespaces: []`
to clear the default namespace grants. Runtime overrides reset to environment
values when the BFF restarts.

### Process lifecycle

| Variable | Required | Default | Range or format | Meaning |
|---|---|---|---|---|
| `FERRUM_SHUTDOWN_TIMEOUT` | No | `10000` | 1000-300000 ms | How long `SIGTERM`/`SIGINT` waits for in-flight requests before the process exits non-zero |

Runtime settings are off by default and should stay off. When they are enabled,
any `admin` identity can repoint the BFF at another allowlisted gateway origin
for the whole process.

## 3. Reverse proxy example (nginx and oauth2-proxy)

This example terminates TLS at nginx, delegates login to oauth2-proxy, maps the
identity provider's groups to a Ferrum role and namespace list, and injects the
four identity headers. Run oauth2-proxy with `--set-xauthrequest` so
`/oauth2/auth` returns `X-Auth-Request-User` and `X-Auth-Request-Groups`, and
with `--reverse-proxy` because it sits behind nginx.

```bash
oauth2-proxy \
  --provider=oidc \
  --oidc-issuer-url=https://idp.example.com/ \
  --client-id="$OAUTH2_CLIENT_ID" \
  --client-secret="$OAUTH2_CLIENT_SECRET" \
  --cookie-secret="$OAUTH2_COOKIE_SECRET" \
  --redirect-url=https://foundry.example.com/oauth2/callback \
  --scope="openid email profile groups" \
  --oidc-groups-claim=groups \
  --email-domain=example.com \
  --allowed-group=ferrum-admins \
  --allowed-group=ferrum-operators \
  --allowed-group=ferrum-viewers \
  --set-xauthrequest=true \
  --reverse-proxy=true \
  --http-address=0.0.0.0:4180
```

`--allowed-group` denies a user who is in none of the Ferrum groups at login,
before nginx ever reaches the mapping below.

Keep the proof secret out of the checked-in nginx configuration. The block below
pulls it from a separate file that holds one line,
`set $ferrum_proxy_secret "<FERRUM_TRUSTED_PROXY_SECRET>";`, deployed with
restrictive file permissions or rendered from a secret manager.

```nginx
# http context: group-to-role and group-to-namespace policy.
# The default is empty so an unmapped user is denied. nginx takes the first
# matching pattern, so the highest privilege is listed first.
map $auth_groups $ferrum_role {
    default                          "";
    "~(^|,)ferrum-admins(,|$)"       "admin";
    "~(^|,)ferrum-operators(,|$)"    "operator";
    "~(^|,)ferrum-viewers(,|$)"      "viewer";
}

map $auth_groups $ferrum_namespaces {
    default                          "";
    "~(^|,)ferrum-admins(,|$)"       "production,staging";
    "~(^|,)ferrum-operators(,|$)"    "production";
    "~(^|,)ferrum-viewers(,|$)"      "staging";
}

server {
    listen 443 ssl;
    http2 on;
    server_name foundry.example.com;

    ssl_certificate     /etc/nginx/tls/foundry.crt;
    ssl_certificate_key /etc/nginx/tls/foundry.key;

    # Restore uploads are streamed and can reach 110 MB; API-spec imports 30 MB.
    client_max_body_size 110m;

    # oauth2-proxy endpoints.
    location /oauth2/ {
        proxy_pass       http://oauth2-proxy:4180;
        proxy_set_header Host             $host;
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Auth-Request-Redirect $request_uri;
    }

    # Internal subrequest target for auth_request.
    location = /oauth2/auth {
        internal;
        proxy_pass       http://oauth2-proxy:4180;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host             $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        auth_request /oauth2/auth;
        error_page 401 = @signin;

        auth_request_set $auth_user   $upstream_http_x_auth_request_user;
        auth_request_set $auth_groups $upstream_http_x_auth_request_groups;

        include /etc/nginx/secrets/ferrum-proxy-secret.conf;

        # proxy_set_header REPLACES any client-supplied header of the same name.
        # These four lines are the stripping guarantee as well as the injection.
        proxy_set_header X-Ferrum-Auth-Secret $ferrum_proxy_secret;
        proxy_set_header X-Forwarded-User     $auth_user;
        proxy_set_header X-Ferrum-Role        $ferrum_role;
        proxy_set_header X-Ferrum-Namespaces  $ferrum_namespaces;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Stream large restores instead of buffering them to disk. A restore may
        # take up to two minutes on the gateway.
        proxy_request_buffering off;
        proxy_read_timeout 180s;

        proxy_pass http://foundry:8080;
    }

    # A browser loading a page is sent through the login flow. An XHR from the
    # SPA keeps the raw 401 so the app can offer "Continue with SSO" itself and
    # never receives a sign-in page where it expects JSON.
    location @signin {
        if ($request_uri ~ ^/api/) {
            return 401;
        }
        return 302 /oauth2/start?rd=$request_uri;
    }
}
```

On the Foundry side, point the SPA's sign-in and sign-out actions at the same
proxy endpoints:

```bash
FERRUM_AUTH_LOGIN_URL=/oauth2/start
FERRUM_AUTH_LOGOUT_URL=/oauth2/sign_out
```

Notes:

- `X-Ferrum-Namespaces` must be an exact comma-separated list of namespace
  names. Foundry does not expand wildcards or prefixes. A name that does not
  match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$` invalidates the whole header.
- A `viewer` or `operator` identity is rejected outright when the namespace
  header is missing or empty. Only `admin` may omit it, and only when global
  administration is the intent.
- Namespace grants scope resources that carry `X-Ferrum-Namespace`. They do not
  scope fleet-global surfaces such as TLS inventory, managed TLS material, ACME,
  rotation, and validation. Restrict those routes at the proxy when a scoped
  identity must not reach them.
- `map` blocks belong in the `http` context, outside the `server` block. The
  mapped variables resolve when `proxy_set_header` uses them, which is after
  `auth_request` has run. Do not try to gate on `$ferrum_role` with an `if`:
  `if` runs in the rewrite phase, before the auth subrequest, so it would always
  see an empty value. The `if` inside `@signin` is safe because it tests only
  `$request_uri`, and a named location entered through `error_page` runs after
  the auth subrequest has already failed.
- Keep the split in `@signin`. The SPA calls `/api/auth/session` on load and
  every minute afterwards and expects a `401` when the proxy session is gone;
  a redirect or an HTML sign-in page in its place shows a generic session error
  instead of the sign-in button.
- Denial for an unmapped user happens twice. oauth2-proxy's `--allowed-group`
  refuses the login, and the empty `map` default means no role is asserted, so
  Foundry rejects the request with `401` and an `x-ferrum-auth-layer: bff`
  header.
- Any header you do not overwrite with `proxy_set_header` is forwarded from the
  client as-is, so keep all four lines even when a value is empty.
- `proxy_request_buffering off` streams a client's body straight through, so
  keep `proxy_read_timeout` and `client_body_timeout` at or below Foundry's
  upload budget (`FERRUM_UPLOAD_TIMEOUT`, and `FERRUM_WRITE_TIMEOUT` for
  ordinary routes). A proxy willing to hold a request open longer than the BFF
  will accept a body only ties up a connection on both sides.

### Live-apply monitoring and ACME issuance deadlines

Foundry requests 25-second config apply-status long polls with a 30-second
browser deadline. Pending responses continue monitoring; they do not mean the
status endpoint is unavailable. The BFF allows at least 35 seconds for this GET,
even when `FERRUM_READ_TIMEOUT` is lower.

ACME finalization waits synchronously in the gateway. Foundry explicitly sends
the requested polling budget (default 60 seconds; accepted range 1–600) and gives
the browser five additional seconds. Invalid budgets are rejected before sending.
The BFF allows at least 610 seconds specifically for the finalize POST, including
its upstream HTTP transport deadlines. These route allowances override a lower
`FERRUM_READ_TIMEOUT`; other routes retain their ordinary deadlines.

Configure any outer reverse proxy or load balancer to allow at least 35 seconds
for apply-status and 610 seconds for ACME finalization responses. In particular,
the general 180-second nginx example above needs a larger response timeout for
finalizations requesting more than 175 seconds. A lower infrastructure maximum
can still interrupt the response; it does not prove the gateway stopped issuing.

On timeout, disconnect, or a server error, Foundry reports finalization as
**in progress / unknown** and replaces Finalize with **Re-check status**, which
GETs the order without repeating the POST. Continue checking until the gateway
reports a terminal status. Do not blindly retry issuance after navigating away
or reloading the page; the interrupted-operation warning is local to the open
ACME view. Finalization has no automatic HTTP or mutation retries.

## 4. Docker Compose example

The BFF publishes no host port. Only the proxy does.

```yaml
services:
  foundry:
    image: ferrumedge/ferrum-foundry:vX.Y.Z
    restart: unless-stopped
    expose:
      - "8080"
    environment:
      NODE_ENV: production
      FERRUM_ADMIN_URL: https://ferrum-admin.internal:9000
      FERRUM_JWT_SECRET: ${FERRUM_JWT_SECRET}
      FERRUM_JWT_AUDIENCE: ferrum-admin
      FERRUM_AUTH_MODE: trusted-proxy
      FERRUM_TRUSTED_PROXY_SECRET: ${FERRUM_TRUSTED_PROXY_SECRET}
      FERRUM_AUTH_LOGIN_URL: /oauth2/start
      FERRUM_AUTH_LOGOUT_URL: /oauth2/sign_out
      FERRUM_TLS_CA_ROOT: /etc/ferrum/ca
      FERRUM_TLS_CA_PATH: /etc/ferrum/ca/gateway-ca.pem
      FERRUM_ENABLE_HSTS: "true"
      FERRUM_SHUTDOWN_TIMEOUT: "10000"
    volumes:
      - ./ca:/etc/ferrum/ca:ro

  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:v7.7.1
    restart: unless-stopped
    expose:
      - "4180"
    env_file:
      - .env
    command:
      - --provider=oidc
      - --oidc-issuer-url=https://idp.example.com/
      - --redirect-url=https://foundry.example.com/oauth2/callback
      - --scope=openid email profile groups
      - --oidc-groups-claim=groups
      - --email-domain=example.com
      - --allowed-group=ferrum-admins
      - --allowed-group=ferrum-operators
      - --allowed-group=ferrum-viewers
      - --set-xauthrequest=true
      - --reverse-proxy=true
      - --http-address=0.0.0.0:4180

  proxy:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on:
      - foundry
      - oauth2-proxy
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./secrets:/etc/nginx/secrets:ro
      - ./tls:/etc/nginx/tls:ro
```

Put `FERRUM_JWT_SECRET`, `FERRUM_TRUSTED_PROXY_SECRET`,
`OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, and
`OAUTH2_PROXY_COOKIE_SECRET` in `.env` with restrictive permissions, and keep
`.env` out of version control. Compose substitutes the `${...}` references in
the `foundry` service from that file, and oauth2-proxy reads its
`OAUTH2_PROXY_*` variables from it through `env_file`. The `foundry` service
deliberately has no `env_file`, so the OAuth client secret never enters the
BFF's environment.

The image ships a `HEALTHCHECK` that requests `/api/health/live` on the
container's own `PORT`, so `docker ps` reports the container unhealthy when the
process stops answering. It deliberately does not use readiness, because a
gateway outage should not make Docker restart Foundry.

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

- The Service is `ClusterIP` on purpose. Do not add a `LoadBalancer`, a
  `NodePort`, or an Ingress rule that reaches this Service without going through
  the identity-aware proxy. The Ingress controller, gateway, or service mesh in
  front must perform the OIDC login and inject the four identity headers, and
  must strip client copies of them. A `NetworkPolicy` that admits ingress only
  from the proxy's pods is the enforcement, not a convention.
- `FERRUM_TLS_CA_PATH` points at a file inside the Secret mount and
  `FERRUM_TLS_CA_ROOT` at the mount directory. Kubernetes projects Secret keys
  through a rotating `..data` symlink; the BFF resolves the symlink inside the
  approved root and reloads the bundle after a rotation.
- Accepted runtime settings return their own canonical values without waiting
  for unrelated gateway calls to drain. Signing-only changes reuse the existing
  transport. A subsequent request with changed connection settings selects a
  new dispatcher while the previous one drains its captured requests. Shutdown
  waits for active and retired dispatchers within the existing process deadline.
  Concurrent saves publish when validation completes; responses may finish in
  a different order and each describes the settings that request accepted.
- `terminationGracePeriodSeconds` must be larger than `FERRUM_SHUTDOWN_TIMEOUT`
  so the process finishes its own bounded drain before the kubelet sends
  `SIGKILL`. 30 seconds against a 10000 ms timeout leaves room.
- Trusted-proxy mode keeps no per-user server state, so replicas need no sticky
  sessions and can scale freely. Static mode keeps sessions in one process's
  memory and is development-only and single-replica.
- `readOnlyRootFilesystem: true` works because the BFF writes nothing to disk.

## 6. Health, logging, and operations

### Health endpoints

| Path | Meaning |
|---|---|
| `GET /api/health/live` | Process liveness. Returns `200` with `{"status":"ok","version":"..."}` as long as the event loop is serving. Never touches the gateway. |
| `GET /api/health/ready` | Downstream readiness. Probes the gateway and reports the result. |
| `GET /api/health` | Alias of `/api/health/live`. |

Readiness makes two authenticated calls to the gateway: `GET /health`, and then
`GET /namespaces?offset=0&limit=1` to prove that the minted JWT is actually
accepted. `/namespaces` is used because it is authenticated but fleet-global, so
the probe does not have to invent a tenant. The result is cached for 5 seconds
and concurrent probes share one in-flight check, so a probe interval below 5
seconds does not multiply gateway load.

Readiness returns `200` with `status` of `ready` or `degraded` when the gateway
answers both calls, and `503` with a JSON body and `status: "unavailable"` when
the gateway is unreachable, unhealthy, or rejects the JWT. Wire the readiness
probe so a gateway outage or a signing-key mismatch takes Foundry out of
rotation instead of serving an admin UI that cannot reach anything.

The header checks BFF readiness every 15 seconds. It shows **Unreachable** when
the browser's readiness request fails, even if a previous check succeeded, and
returns to **Connected** after a successful ready response. Gateway responses
with `degraded` or `unavailable` status show **Degraded** or **Disconnected**.

All three endpoints are unauthenticated, which is why liveness carries no
gateway detail and readiness reports only component status, HTTP status, and the
Foundry version.

### Logging

Logs are pino JSON on stdout. The level is `info` when `NODE_ENV=production` and
`debug` otherwise. Ship stdout to your log pipeline; the BFF writes no log
files.

The BFF never logs the CA bundle PEM, `FERRUM_JWT_SECRET`,
`FERRUM_TRUSTED_PROXY_SECRET`, `FERRUM_BFF_AUTH_TOKEN`, or a minted JWT. Runtime
settings changes are logged with the acting subject and the changed field names;
`adminUrl` and `tlsCaPath` values are replaced with a redaction marker.

API responses are sent with `cache-control: no-store`. Hashed static assets are
immutable for a year; `index.html` and `theme-bootstrap.js` are never cached.

### Upload bounds

A proxied request body is bounded twice. `FERRUM_WRITE_TIMEOUT` limits the idle
gap between chunks, and `FERRUM_UPLOAD_TIMEOUT` is an absolute deadline for the
whole body that a slowly progressing sender cannot extend; ordinary 2 MiB routes
use `FERRUM_WRITE_TIMEOUT` for both. Either bound answers `504` with `code:
FERRUM_BFF_TIMEOUT`, `phase: "upload"`, and a `reason` of `idle` or `deadline`,
so a response says which bound fired. As a backstop, the HTTP server closes any
request that has still not fully arrived five seconds past
`FERRUM_UPLOAD_TIMEOUT`.

Concurrency is bounded twice as well: `FERRUM_MAX_ACTIVE_UPLOADS` covers every
proxied request carrying a body, and `FERRUM_MAX_LARGE_UPLOADS` is a stricter
inner bound on the restore and API-spec routes. Both answer `429` with `code:
FERRUM_BFF_UPLOAD_CAPACITY`, `retry-after: 1`, and a `scope` of `all` or
`large`. Sustained `429`s at `scope: "all"` mean the instance is at its
body-bearing request ceiling; raise the cap only alongside the socket and memory
headroom to match.

### Graceful shutdown

On `SIGTERM` or `SIGINT` the BFF stops accepting new connections, waits for
in-flight requests to finish, and closes its gateway connection pool.
`FERRUM_SHUTDOWN_TIMEOUT` bounds that wait: if requests are still running when
it expires, the process exits with a non-zero status rather than hanging. Set
the orchestrator's grace period above this value.

### Upgrade and rollback

Published images carry immutable and mutable tags:

| Tag | Moves? | Use |
|---|---|---|
| `vX.Y.Z` | Never | Production deployments |
| `main-<commit>` | Never | Staging a specific `main` build |
| `main` | Yes | Tracking `main`, non-production only |
| `latest` | Yes | Convenience only; it follows the newest stable release |

Deploy an immutable tag, and pin by digest when you need byte-identical
rollouts:

```bash
docker pull ferrumedge/ferrum-foundry:vX.Y.Z
docker image inspect --format '{{index .RepoDigests 0}}' ferrumedge/ferrum-foundry:vX.Y.Z
```

Roll back by redeploying the previous immutable tag or digest. Foundry keeps no
persistent state of its own, so a rollback is a pod or container replacement.
Confirm that the previous version's `FERRUM_JWT_AUDIENCE` and
`FERRUM_JWT_SECRET` still match the gateway before rolling back across a
gateway change.

Images are built for `linux/amd64` and `linux/arm64`, and published images carry
build provenance and SBOM attestations. See
[Release and supply-chain gates](release-security.md).

## 7. Production checklist

- [ ] TLS terminates at the identity-aware proxy, with a current certificate.
- [ ] The proxy strips client copies of `X-Ferrum-Auth-Secret`,
      `X-Forwarded-User`, `X-Ferrum-Role`, and `X-Ferrum-Namespaces` and injects
      its own values for all four.
- [ ] Group-to-role mapping denies by default, so an unmapped user gets no role.
- [ ] Every non-admin identity receives an exact `X-Ferrum-Namespaces` list.
- [ ] `FERRUM_JWT_SECRET` and `FERRUM_TRUSTED_PROXY_SECRET` are at least 32
      characters, generated from a CSPRNG, held in a secret store, and on a
      rotation schedule.
- [ ] `FERRUM_JWT_SECRET` matches the gateway's `FERRUM_ADMIN_JWT_SECRET`.
- [ ] `NODE_ENV=production` is set.
- [ ] `FERRUM_AUTH_MODE=trusted-proxy` is set and
      `FERRUM_ALLOW_INSECURE_STATIC_AUTH` is unset.
- [ ] `FERRUM_BFF_AUTH_TOKEN` is not present in the production environment.
- [ ] The BFF port is reachable only from the proxy, enforced by firewall,
      network policy, or private network.
- [ ] `FERRUM_ADMIN_URL` uses `https`, and `FERRUM_TLS_CA_PATH` plus
      `FERRUM_TLS_CA_ROOT` are set when the gateway uses a private CA.
- [ ] `FERRUM_TLS_VERIFY` is left at `true`.
- [ ] `FERRUM_ALLOW_RUNTIME_SETTINGS` is left at `false`.
- [ ] `FERRUM_ENABLE_HSTS=true` only when the proxy serves this host over HTTPS
      exclusively, including every subdomain.
- [ ] `FERRUM_JWT_AUDIENCE` matches the gateway's `FERRUM_ADMIN_JWT_AUDIENCE`,
      or both are unset.
- [ ] `FERRUM_AUTH_LOGIN_URL` and `FERRUM_AUTH_LOGOUT_URL` point at the proxy's
      real sign-in and sign-out endpoints.
- [ ] The readiness probe is wired to `/api/health/ready` and the liveness probe
      to `/api/health/live`.
- [ ] The orchestrator grace period exceeds `FERRUM_SHUTDOWN_TIMEOUT`.
- [ ] Container stdout is shipped to a log pipeline and retained.
- [ ] The deployed image is an immutable `vX.Y.Z` tag or a digest.
