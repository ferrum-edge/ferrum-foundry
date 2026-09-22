# Getting started: from nothing to an authenticated request

This is the first-success path. At the end of it you will have logged in
through your identity proxy, created a route, protected it with key
authentication, and proved with two requests that the route refuses an
anonymous caller and serves an authenticated one **through the real data
plane**.

The same steps run in CI, as `scripts/starter-journey.mjs`, against the
checked-in starter, the production Foundry image, and the pinned Ferrum Edge
gateway — so if the gateway's behaviour changes under this walkthrough, the
build says so.

- The runnable stack: [`deploy/starter/`](../deploy/starter/README.md)
- The full configuration reference: [deployment.md](deployment.md)

## What you need

- Docker with Compose.
- Either your own Ferrum Edge gateway and an OIDC provider, or nothing at all
  — the `demo` profile brings up a disposable gateway, a disposable backend,
  and a stub identity provider so you can walk this path first and connect
  real systems afterwards.

## 1. Bring the stack up

```bash
cd deploy/starter
./bootstrap-demo.sh
docker compose --profile demo up -d
```

`bootstrap-demo.sh` generates throwaway secrets and refuses to overwrite an
existing `.env`, so it can never clobber a real configuration. For your own
gateway and IdP, copy `.env.example` to `.env` instead and use
`--profile production`; see the starter README.

## 2. Run the preflight

```bash
FERRUM_ADMIN_URL=http://127.0.0.1:9000 \
FOUNDRY_PREFLIGHT_URL=http://127.0.0.1:8088 \
node ../../scripts/starter-preflight.mjs --env .env
```

It checks configuration shape, gateway reachability, TLS trust, that the
signing key and audience the BFF will use are the ones the gateway accepts,
that your namespace is served, and that the front door refuses both an
anonymous request and a forged identity header. It writes nothing and prints
no secret.

Read the verdicts literally. `UNKNOWN` is not a pass — it means the check
could not be performed from where it ran, and the deployment still has to
confirm it. On the demo stack two are expected: the admin URL is plaintext,
and gateway TLS trust therefore does not apply.

## 3. Sign in

Open `http://127.0.0.1:8088` (demo) or your public URL (production).

In production the proxy runs the OIDC flow, maps your groups to a Ferrum role
and namespace grants, and asserts them to Foundry. In the demo profile a stub
supplies the identity instead — the mapping, the grants, and the header
handling are the production ones.

For the curl commands below, the demo stack names an identity with a header:

```bash
export FOUNDRY=http://127.0.0.1:8088
export IDENTITY='X-Demo-Identity: admin'     # demo only
export NAMESPACE='X-Ferrum-Namespace: ferrum-foundry-demo'
```

In production drop `IDENTITY` and use a real browser session instead: the
proxy will not accept a header as proof of who you are, which is the point.

Writes are CSRF-protected, so start a session and keep its cookie:

```bash
COOKIES=$(mktemp)
CSRF=$(curl -s -c "$COOKIES" -H "$IDENTITY" "$FOUNDRY/api/auth/session" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])')
```

## 4. Choose a namespace

Every resource below is created inside one namespace, named per request by
`X-Ferrum-Namespace`. It must be one your identity was granted: the gateway
answers `403 Namespace access denied` for anything else, however privileged
your role is.

## 5. Create an upstream and a route

```bash
curl -s -b "$COOKIES" -X POST "$FOUNDRY/api/proxy/upstreams?apply=sync" \
  -H "$IDENTITY" -H "$NAMESPACE" -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{
        "id": "starter-upstream",
        "name": "Starter backend",
        "algorithm": "round_robin",
        "targets": [{ "host": "demo-backend", "port": 8081, "weight": 1 }]
      }'

curl -s -b "$COOKIES" -X POST "$FOUNDRY/api/proxy/proxies?apply=sync" \
  -H "$IDENTITY" -H "$NAMESPACE" -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{
        "id": "starter-route",
        "name": "Starter route",
        "listen_path": "/starter",
        "backend_scheme": "http",
        "backend_host": "demo-backend",
        "backend_port": 8081,
        "upstream_id": "starter-upstream",
        "strip_listen_path": true,
        "hosts": []
      }'
```

`apply=sync` asks the gateway to wait until the change is live on the process
that served the request. **A `201` alone is not proof the route is serving
traffic.** In database mode the row can be durable while the reload has not
applied, and the gateway then answers `503` with `applied: false`. The UI
shows this as a live-apply banner; in a script, check the response and use the
data-plane request in step 8 as the real confirmation.

The route is already live, unauthenticated:

```bash
curl -s http://127.0.0.1:8000/starter/hello
# {"service":"starter-demo-backend","path":"/hello","saw_api_key":false}
```

## 6. Protect it with key authentication

This is two steps, and the second one is easy to miss.

Create the plugin configuration:

```bash
curl -s -b "$COOKIES" -X POST "$FOUNDRY/api/proxy/plugins/config?apply=sync" \
  -H "$IDENTITY" -H "$NAMESPACE" -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{
        "id": "starter-keyauth",
        "plugin_name": "key_auth",
        "scope": "proxy",
        "proxy_id": "starter-route",
        "enabled": true,
        "config": { "key_location": "header:X-API-Key" }
      }'
```

Then **attach it to the proxy**. The association that makes a plugin run lives
on the proxy's `plugins` list. The admin API contract says the gateway appends
it when a proxy-scoped plugin is written; the gateway image this starter pins
does not, so the plugin exists, names the proxy, is enabled — and does not
run. The route stays open while everything looks configured.

Attaching it yourself is safe either way: on a gateway that already attached
it, the call below changes nothing. Foundry's plugin editor does this check
for you once #393 is merged; by hand it is a second call.

Proxy `PUT` is a **full replacement**, so read the proxy, add the
association, and send the whole object back:

```bash
CURRENT=$(curl -s -b "$COOKIES" -H "$IDENTITY" -H "$NAMESPACE" \
  "$FOUNDRY/api/proxy/proxies/starter-route")

BODY=$(python3 - "$CURRENT" <<'PY'
import json, sys
proxy = json.loads(sys.argv[1])
for field in ("created_at", "updated_at", "namespace", "api_spec_id"):
    proxy.pop(field, None)
proxy["plugins"] = [{"plugin_config_id": "starter-keyauth"}]
print(json.dumps(proxy))
PY
)

curl -s -b "$COOKIES" -X PUT "$FOUNDRY/api/proxy/proxies/starter-route?apply=sync" \
  -H "$IDENTITY" -H "$NAMESPACE" -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' -d "$BODY"
```

## 7. Create a consumer and copy its credential

```bash
curl -s -b "$COOKIES" -X POST "$FOUNDRY/api/proxy/consumers?apply=sync" \
  -H "$IDENTITY" -H "$NAMESPACE" -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{
        "id": "starter-consumer",
        "username": "starter-client",
        "credentials": { "keyauth": [{ "key": "starter-demo-key-do-not-reuse" }] }
      }'
```

**Copy the key now.** Ordinary reads redact it as the literal `[REDACTED]`;
the UI shows a new credential once, at creation, for the same reason. The key
above is a throwaway for this walkthrough — generate a real one with
`openssl rand -base64 32` for anything else.

## 8. Prove it, both ways

This is the step that makes the walkthrough meaningful. A green health
response proves the BFF is up; it proves nothing about your route.

```bash
# Anonymous: must be refused by the gateway, not by the backend.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/starter/hello
# 401

# Authenticated: must reach the backend.
curl -s -H 'X-API-Key: starter-demo-key-do-not-reuse' \
  http://127.0.0.1:8000/starter/hello
# {"service":"starter-demo-backend","path":"/hello","saw_api_key":false}
```

`saw_api_key: false` on a successful call is correct and worth noticing:
`key_auth` defaults to `hide_credentials: true`, so the gateway strips the key
before forwarding. Your backend never sees a reusable credential unless you
deliberately turn that off.

Point `http://127.0.0.1:8000` at your own data-plane origin for a real
deployment; nothing else in the two commands changes.

## 9. Check what the gateway reports

In the UI: **Dashboard** for connection and health, **Metrics** for live
traffic, **Audit** for the record of the changes you just made.

One caveat the UI states and that is worth repeating: **no audit rows is not
evidence of no mutations.** Audit collection can be disabled on the gateway,
and Foundry reports collection status separately from the row count. Read the
status before concluding anything from an empty list.

## 10. Tear down

```bash
cd deploy/starter
docker compose --profile demo down -v
```

That removes the disposable gateway, its database, the backend, and the
stack's network. It does not touch your `.env` or the generated secret file —
delete those yourself when you are finished.

For a production stack, `docker compose --profile production down` stops
Foundry and the proxy and leaves your gateway alone. Foundry stores nothing of
its own: it has no database, and every resource you created above lives in the
gateway.

**Do not run the demo seeding scripts against a gateway you care about.**
`scripts/seed-demo-gateway.mjs` replaces the contents of a namespace and
requires `FERRUM_DEMO_CONFIRM_TARGET` to match its exact target for that
reason. It is not part of setup.

## If something did not work

| Symptom | Where to look |
| --- | --- |
| The sign-in page loops, or the SPA shows a session error | The proxy's `@signin` split: an XHR to `/api/…` must get a raw `401`, not a redirect or an HTML page |
| Logged in, but every request is `401` | The group-to-role map asserted no role. An unmapped user is denied by design — check `nginx/identity/policy.conf` against your IdP's group names |
| `403 Namespace access denied` | `X-Ferrum-Namespaces` does not grant the namespace in `X-Ferrum-Namespace`, or the gateway does not serve it |
| Every admin call is `401` at the gateway | `FERRUM_JWT_SECRET` must equal the gateway's `FERRUM_ADMIN_JWT_SECRET`, and `FERRUM_JWT_AUDIENCE` its `FERRUM_ADMIN_JWT_AUDIENCE`. The preflight reports this directly |
| A write returns `403` with a CSRF message | Start a session first and send its `X-CSRF-Token` with the session cookie |
| The route answers but ignores the plugin | The association in step 6 was not attached, or the plugin is `enabled: false` |
| A save returned `503` with `applied: false` | The row is durable but the reload did not apply. The change is not live; check the gateway's logs before changing anything else |

Run the preflight again after any change. It is non-destructive and safe to
repeat.
