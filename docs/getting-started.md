# Getting started: from nothing to an authenticated request

By the end you will have signed in through your identity proxy, created a
route, protected it with key authentication, and proved with two requests that
the route refuses an anonymous caller and serves an authenticated one
**through the real data plane**.

CI runs the same steps (`scripts/starter-journey.mjs`) against the checked-in
starter, the production Foundry image, and the pinned Ferrum Edge image
([compatibility.md](compatibility.md)). If the gateway's behavior changes under
this walkthrough, the build fails.

- The runnable stack: [`deploy/starter/`](../deploy/starter/README.md)
- The full configuration reference: [deployment.md](deployment.md)

## What you need

- Docker with Compose.
- Either your own Ferrum Edge gateway (the release named in
  [compatibility.md](compatibility.md)) and an OIDC provider, or nothing else:
  the `demo` profile brings up a disposable gateway, a disposable backend, and
  a stub identity provider, so you can walk through this first and connect
  real systems later.

## 1. Bring the stack up

```bash
cd deploy/starter
./bootstrap-demo.sh
docker compose --profile demo up -d
```

`bootstrap-demo.sh` writes throwaway secrets and refuses to overwrite an
existing `.env`. For your own gateway and IdP, copy `.env.example` to `.env`
instead and use `--profile production`; see the
[starter README](../deploy/starter/README.md#production).

## 2. Run the preflight

```bash
FERRUM_ADMIN_URL=http://127.0.0.1:9000 \
FOUNDRY_PREFLIGHT_URL=http://127.0.0.1:8088 \
node ../../scripts/starter-preflight.mjs --env .env
```

The preflight checks:

- configuration shape and secret lengths;
- gateway reachability and TLS trust;
- that the gateway accepts the BFF's signing key and audience;
- that your namespace is served;
- that the front door refuses an anonymous request and a forged identity header.

It writes nothing and prints no secret.

`UNKNOWN` is not a pass. It means the check could not be done from where it
ran, and you still have to confirm it. The demo stack reports two: the admin URL
is plaintext, so gateway TLS trust does not apply.

## 3. Sign in

Open `http://127.0.0.1:8088` (demo) or your public URL (production).

In production the proxy runs the OIDC flow, maps your groups to a Ferrum role
and namespace grants, and asserts them to Foundry. In the demo profile a stub
supplies the identity; the group mapping, grants, and header handling are the
production ones.

For the curl commands below, the demo stack names an identity with a header:

```bash
export FOUNDRY=http://127.0.0.1:8088
export IDENTITY='X-Demo-Identity: admin'     # demo only
export NAMESPACE='X-Ferrum-Namespace: ferrum-foundry-demo'
```

In production drop `IDENTITY` and use a real browser session. The proxy does
not accept a header as proof of who you are.

Writes are CSRF-protected, so start a session and keep its cookie:

```bash
COOKIES=$(mktemp)
CSRF=$(curl -s -c "$COOKIES" -H "$IDENTITY" "$FOUNDRY/api/auth/session" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])')
```

## 4. Choose a namespace

Every resource below lives in one namespace, named on each request by
`X-Ferrum-Namespace`. It must be one your identity was granted. Foundry answers
`403 Namespace access denied` for any other namespace, whatever your role.

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
that served the request. **A stored row is not proof the route serves
traffic.** In database mode the row can be saved while the reload has not
applied; the gateway then answers `503` with `applied: false`. The UI shows
this as a live-apply banner. In a script, check the response, and treat the
data-plane request in step 8 as the real confirmation.

The route is already live, unauthenticated:

```bash
curl -s http://127.0.0.1:8000/starter/hello
# {"service":"starter-demo-backend","path":"/hello","saw_api_key":false}
```

## 6. Protect it with key authentication

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

A plugin runs only when the proxy's own `plugins` list names it. The
plugin's `proxy_id` records intent, not attachment. Ferrum Edge 0.9.x in
`database` mode writes the association for you: a `201` for a proxy-scoped
plugin config means the gateway also appended
`{"plugin_config_id": "starter-keyauth"}` to the proxy in the same
transaction. The route is protected from now on. No consumer exists yet, so
even this request is refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/starter/hello
# 401
```

Check the association where the gateway looks for it, on the proxy:

```bash
curl -s -b "$COOKIES" -H "$IDENTITY" -H "$NAMESPACE" \
  "$FOUNDRY/api/proxy/proxies/starter-route" \
  | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["plugins"]))'
# [{"plugin_config_id": "starter-keyauth"}]
```

If the list does not name the plugin (on a gateway older than 0.9, for
example), the plugin exists and is enabled but does not run, and the route
stays open. Attach it yourself with the call below. On a gateway that already
attached it, the call changes nothing; CI sends it anyway and checks that.
Foundry's plugin editor makes the same check after every proxy-scoped plugin
write (see [plugin membership](plugin-membership.md)).

Proxy `PUT` is a **full replacement**: read the proxy, add the association if
it is missing, and send the whole object back. The `plugins` list you send
replaces the stored one, so keep the existing entries:

```bash
CURRENT=$(curl -s -b "$COOKIES" -H "$IDENTITY" -H "$NAMESPACE" \
  "$FOUNDRY/api/proxy/proxies/starter-route")

BODY=$(python3 - "$CURRENT" <<'PY'
import json, sys
proxy = json.loads(sys.argv[1])
for field in ("created_at", "updated_at", "namespace", "api_spec_id"):
    proxy.pop(field, None)
plugins = proxy.get("plugins") or []
if not any(entry["plugin_config_id"] == "starter-keyauth" for entry in plugins):
    plugins.append({"plugin_config_id": "starter-keyauth"})
proxy["plugins"] = plugins
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

**Copy the key now.** Later reads return it redacted as `[REDACTED]`, and the
UI shows a new credential only once, at creation. The key above is a throwaway
for this walkthrough; generate a real one with `openssl rand -base64 32`.

## 8. Prove it, both ways

A green health check proves the BFF is up. It proves nothing about your
route; these two requests do.

```bash
# Anonymous: must be refused by the gateway, not by the backend.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/starter/hello
# 401

# Authenticated: must reach the backend.
curl -s -H 'X-API-Key: starter-demo-key-do-not-reuse' \
  http://127.0.0.1:8000/starter/hello
# {"service":"starter-demo-backend","path":"/hello","saw_api_key":false}
```

`saw_api_key: false` is correct. `key_auth` defaults to
`hide_credentials: true`, so the gateway strips the key before forwarding, and
your backend never sees a reusable credential.

For a real deployment, replace `http://127.0.0.1:8000` with your data-plane
origin; nothing else changes.

## 9. Check what the gateway reports

In the UI: **Dashboard** for connection and health, **Metrics** for live
traffic, **Audit** for the record of the changes you just made.

**No audit rows does not mean no changes.** Audit collection can be disabled
on the gateway, so Foundry reports collection status separately from the row
count. Check the status before trusting an empty list.

## 10. Tear down

```bash
cd deploy/starter
docker compose --profile demo down -v
```

This removes the disposable gateway, its database, the backend, and the
network. It leaves `.env` and `secrets/ferrum-proxy-secret.conf`; delete them
yourself.

For a production stack, `docker compose --profile production down` stops
Foundry and the proxy and leaves your gateway alone. Foundry stores nothing of
its own; everything you created lives in the gateway.

**Do not run the demo seeder against a gateway you care about.**
`scripts/seed-demo-gateway.mjs` replaces a whole namespace and is not part of
setup.

## If something did not work

| Symptom | Where to look |
| --- | --- |
| The sign-in page loops, or the SPA shows a session error | The proxy's `@signin` split: an XHR to `/api/…` must get a raw `401`, not a redirect or an HTML page |
| Logged in, but every request is `401` | The group-to-role map asserted no role. An unmapped user is denied by design — check `nginx/identity/policy.conf` against your IdP's group names |
| `403 Namespace access denied` | `X-Ferrum-Namespaces` does not grant the namespace in `X-Ferrum-Namespace` (Foundry refuses), or the gateway does not serve it |
| Every admin call is `401` at the gateway | `FERRUM_JWT_SECRET` must equal the gateway's `FERRUM_ADMIN_JWT_SECRET`, and `FERRUM_JWT_AUDIENCE` its `FERRUM_ADMIN_JWT_AUDIENCE`. The preflight reports this directly |
| A write returns `403` with a CSRF message | Start a session first and send its `X-CSRF-Token` with the session cookie |
| The route answers but ignores the plugin | The proxy's `plugins` list does not name the plugin (step 6 shows how to check and attach it), or the plugin is `enabled: false` |
| A save returned `503` with `applied: false` | The row is durable but the reload did not apply. The change is not live; check the gateway's logs before changing anything else |

Run the preflight again after any change. It changes nothing and is safe to
repeat.
