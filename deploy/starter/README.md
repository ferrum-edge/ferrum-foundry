# Ferrum Foundry starter

A runnable version of the topology in [`docs/deployment.md`](../../docs/deployment.md):

```
browser -> reverse proxy (the only published port) -> Foundry BFF -> Ferrum Edge
```

The reverse proxy owns TLS and the OIDC login, maps identity-provider groups to
a Ferrum role and namespace grants, and asserts them to Foundry. Foundry turns
that into the `sub`, `role`, and `ns` claims of the admin JWT it signs for each
request.

For a walkthrough that ends in an authenticated request through the data
plane, see [`docs/getting-started.md`](../../docs/getting-started.md).

**Candidate pairing.** The demo profile pins published Edge v0.9.21 for the
Foundry v0.5.7 candidate; hosted qualification and Foundry publication are
pending. The latest published pairing remains **Foundry v0.5.6 / Edge v0.9.20**,
whose [v0.5.6 record](../../docs/release-notes/v0.5.6.compatibility.json)
preserves source `05df8c6cee1718fdd54fc923f2b2d7cf33490398`, hosted
[qualification run 44967080032](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/44967080032)
(source and tested commit `618a75f6`), and
[publication run 44968397446](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/44968397446)
(published 2026-11-22 at 00:57:56 UTC). The default Foundry image remains pinned
to published v0.5.6
(`ferrumedge/ferrum-foundry@sha256:1dbe6878b6833bb56805c6de5f5162f1f4970b7a50d71d8921ea2f6bdd46010e`);
set `FOUNDRY_IMAGE` to another released digest
(`FOUNDRY_IMAGE=ferrumedge/ferrum-foundry@sha256:<digest>`) when selecting a
different pairing. CI runs the starter with the image under test.

## Two profiles

| | `production` | `demo` |
| --- | --- | --- |
| Reverse proxy | nginx, TLS on :443 | nginx, plain HTTP on loopback |
| Identity | oauth2-proxy against your OIDC provider | a local stub keyed by a request header |
| Gateway | yours — run the Ferrum Edge release in the published pairing you deploy | a disposable SQLite Ferrum Edge, the image CI qualifies, pinned by digest |
| Backend | yours | a disposable echo origin |
| Data | yours | throwaway; `down -v` removes it |

**Only the identity source differs.** Both profiles include the same
group-to-role policy (`nginx/identity/policy.conf`) and the same four identity
headers (`nginx/identity/inject.conf`), so the demo exercises the real
authorization path. `scripts/starter-preflight.test.mjs` fails if either
config grows its own copy.

## Files

| Path | What it is |
| --- | --- |
| `compose.yaml` | Both profiles. Third-party images are pinned as `name:tag@sha256:<digest>` |
| `.env.example` | Foundry and gateway inputs, with placeholders. No working secrets |
| `oauth2-proxy.env.example` | Identity-provider settings, PKCE included, read by oauth2-proxy alone |
| `bootstrap-demo.sh` | Generates throwaway demo secrets; refuses to overwrite an existing `.env` |
| `nginx/foundry.conf` | Production reverse proxy |
| `nginx/foundry.demo.conf` | Demo reverse proxy plus the stub identity provider |
| `nginx/identity/policy.conf` | Group → role and group → namespace policy (**shared**) |
| `nginx/identity/inject.conf` | The four identity headers (**shared**) |
| `secrets/`, `tls/`, `ca/` | Mount points; contents are git-ignored |

## Demo

```bash
./bootstrap-demo.sh
docker compose --profile demo up -d

(cd ../.. && npm ci)   # once per checkout: the dependencies the preflight imports
FERRUM_ADMIN_URL=http://127.0.0.1:9000 \
FOUNDRY_PREFLIGHT_URL=http://127.0.0.1:8088 \
node ../../scripts/starter-preflight.mjs --env .env
```

Run these from `deploy/starter`. `bootstrap-demo.sh` needs `openssl`; the
stack itself needs only Docker with Compose. The preflight runs on the host: it
needs Node.js in the `engines` range of [`package.json`](../../package.json)
(22 from 22.22.2, 24 from 24.15.0, or 26 and later) and the repository's npm
dependencies, which `npm ci` installs at the repository root.

Then open <http://127.0.0.1:8088> and follow
[`docs/getting-started.md`](../../docs/getting-started.md).

`bootstrap-demo.sh` also sets `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true`, so the
BFF may reach the throwaway gateway over plaintext on the compose network.
Without it, Foundry refuses a plaintext admin URL to any host but loopback;
the production `.env` leaves it `false` and uses `https`.

It also sets `FERRUM_ENABLE_HSTS=false`, because the demo is plain HTTP. For
the same reason the demo runs Foundry as its own Compose service,
`foundry-demo`, with plain cookies: Safari and other WebKit browsers keep a
`Secure` cookie only over HTTPS, even on loopback, so with secure cookies they
would drop Foundry's session and CSRF cookies and every write would be
refused. The production profile's `foundry` service fixes
`FERRUM_SECURE_COOKIES` to `true` in `compose.yaml` itself, so neither `.env`
nor the shell can turn Secure, `__Host-` cookies off behind the TLS proxy.

The demo publishes only loopback ports (`FOUNDRY_DEMO_PORT` 8088,
`FERRUM_DEMO_PROXY_PORT` 8000, `FERRUM_DEMO_ADMIN_PORT` 9000), and its identity
stub trusts a request header (`X-Demo-Identity: admin`, `operator`, `viewer`,
or `unmapped`). It is for a first run and for CI, on loopback only: never
publish it on another interface or put it behind a public address.

## Production

1. `cp .env.example .env` and `cp oauth2-proxy.env.example oauth2-proxy.env`,
   fill both in, and `chmod 600` both. Generate `FERRUM_JWT_SECRET` and
   `FERRUM_TRUSTED_PROXY_SECRET` with `openssl rand -base64 48`. Generate
   `OAUTH2_PROXY_COOKIE_SECRET` separately, because oauth2-proxy accepts only a
   16-, 24- or 32-byte key: `openssl rand -base64 32 | tr -- '+/' '-_'`. The
   OIDC client secret is the one your identity provider issues.
   `FERRUM_JWT_SECRET` must equal the gateway's
   `FERRUM_ADMIN_JWT_SECRET`, and the BFF always sends the audience in
   `FERRUM_JWT_AUDIENCE` (default `ferrum-admin`), so set the gateway's
   `FERRUM_ADMIN_JWT_AUDIENCE` to the same value. Foundry v0.5.6 and later
   refuse to start while `FERRUM_JWT_SECRET` or `FERRUM_TRUSTED_PROXY_SECRET`
   still holds the `replace-me-...` placeholder from `.env.example`, or (in
   production) one of the development example values printed in the
   contributor instructions. An older Foundry image set through `FOUNDRY_IMAGE`
   starts with either, so do not rely on it to catch them; the preflight
   (step 6) fails on both.

   The files are separate on purpose. `.env` holds the gateway signing key and
   the proof secret; `oauth2-proxy.env` holds the `OAUTH2_PROXY_*` settings,
   which oauth2-proxy reads directly. Each service gets only its own file.
   Keep `OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256` unless your provider lacks
   PKCE (see [Still yours to decide](#still-yours-to-decide)).
   (The IdP settings are not Compose variables because Compose interpolates the
   whole file for every profile, and a production-only requirement would stop
   the demo from starting.)
2. Write `secrets/ferrum-proxy-secret.conf` with the **same** value as
   `FERRUM_TRUSTED_PROXY_SECRET`. Editing `.env` does not put that value in
   your shell, so read it back from the file you just filled in (this also
   fails loudly instead of writing an empty proof value):

   ```bash
   proxy_secret=$(grep '^FERRUM_TRUSTED_PROXY_SECRET=' .env | cut -d= -f2-)
   test -n "$proxy_secret" || { echo "FERRUM_TRUSTED_PROXY_SECRET is empty in .env"; exit 1; }
   printf 'set $ferrum_proxy_secret "%s";\n' "$proxy_secret" \
     > secrets/ferrum-proxy-secret.conf
   chmod 600 secrets/ferrum-proxy-secret.conf
   ```

   This keeps the secret out of the checked-in nginx configuration.
3. Put your certificate and key in `tls/` (`foundry.crt`, `foundry.key`). If
   the gateway presents a private certificate, put its CA in `ca/` and set
   `FERRUM_TLS_CA_ROOT=/etc/ferrum/ca` and `FERRUM_TLS_CA_PATH` in `.env`.
4. Edit `nginx/foundry.conf` for your `server_name` and certificate paths, and
   `nginx/identity/policy.conf` for your IdP's group names and your namespaces.
   If you rename the groups, change oauth2-proxy's `--allowed-group` entries in
   `compose.yaml` to the same names: oauth2-proxy refuses a sign-in (HTTP 403
   on `/oauth2/callback`) before nginx applies the role map.
5. Pin `FOUNDRY_IMAGE` to a released digest, and run the Ferrum Edge release
   named in that published pairing's immutable record linked from
   [`docs/compatibility.md`](../../docs/compatibility.md).
6. Start the stack, then run the preflight from this directory. Use a shell
   without the contributor `FERRUM_*` exports: Compose, and the preflight,
   prefer variables already set in the shell over `.env`.

   ```bash
   docker compose --profile production up -d
   (cd ../.. && npm ci)   # once per checkout: the dependencies the preflight imports
   FOUNDRY_PREFLIGHT_URL=https://foundry.example.com \
   node ../../scripts/starter-preflight.mjs --env .env
   ```

   Set `FOUNDRY_PREFLIGHT_URL` to the public URL browsers use. The preflight
   needs Node.js (see [Demo](#demo)), and it probes the gateway at `.env`'s
   `FERRUM_ADMIN_URL` from this host, so run it where that name resolves.
   With a private gateway CA (step 3), `.env`'s `FERRUM_TLS_CA_ROOT` and
   `FERRUM_TLS_CA_PATH` are paths inside the container, which the preflight
   would read on this host. Point both at this directory's `ca/` for the
   preflight alone by adding them to its command line, for example
   `FERRUM_TLS_CA_ROOT="$PWD/ca" FERRUM_TLS_CA_PATH="$PWD/ca/gateway.pem"`.
   See
   [`docs/getting-started.md`](../../docs/getting-started.md#2-run-the-preflight)
   for what it checks and why `UNKNOWN` is not a pass.

### What the stack gets right

- **The BFF publishes no host port.** Anyone who can reach it and knows the
  proof secret is a gateway administrator, so only the proxy is published.
- **All four identity headers are set with `proxy_set_header`,** which replaces
  any client-supplied copy. Without that, a browser could send
  `X-Ferrum-Role: admin`.
- **An unmapped user is denied twice:** by oauth2-proxy's `--allowed-group` at
  login, and by the empty `map` default, which asserts no role.
- **nginx, not the client, sets what oauth2-proxy trusts.** oauth2-proxy runs
  with `--reverse-proxy`, so on `/oauth2/` and the `/oauth2/auth` subrequest
  nginx sets `X-Forwarded-For`, `-Host`, `-Proto`, `-Uri` and `X-Real-IP`
  from its own view of the request. `X-Auth-Request-Redirect` is set to the
  request URI on the sign-in routes and cleared on the subrequest, and every
  upstream gets nginx's own `X-Request-Id` (`$request_id`), so a client cannot
  choose the request ID oauth2-proxy logs. Both `/oauth2/` and `/oauth2/auth`
  also clear `X-Ferrum-Auth-Secret`, `X-Forwarded-User`, `X-Ferrum-Role`, and
  `X-Ferrum-Namespaces`, so the BFF's proof secret and identity headers never
  reach oauth2-proxy — including when `starter-preflight.mjs` sends the real
  proof secret in its forged-identity probe.
- **oauth2-proxy believes those headers only from this stack's network.**
  The Compose network has a fixed subnet, `10.73.88.0/24` unless
  `FOUNDRY_STARTER_SUBNET` in `.env` says otherwise, and oauth2-proxy runs
  with `--trusted-proxy-ip` set to the same value. A request from an address
  outside that range is judged by its own Host, path and peer address, so a
  client outside the range that reaches oauth2-proxy directly cannot choose
  the redirect, host or client address it acts on. The range is not nginx
  alone: it also holds the Docker host (the bridge gateway, which a Compose
  subnet always includes) and every container on the network, and each of
  them is believed as nginx is. Anything that can send from the Docker host
  is therefore trusted, so attach nothing else to the network. The
  production smoke test sends the same forged headers from inside and from
  outside the range and checks that only the inside copy is believed.
- **nginx, not the client, sets what Foundry trusts.** The BFF trusts
  `X-Forwarded-*` from nginx, its directly connected hop, so on `location /`
  (in both profiles) nginx sets `X-Forwarded-Host`, `-Proto` and `X-Real-IP`,
  clears `X-Forwarded-Uri`, `X-Auth-Request-Redirect` and oauth2-proxy's
  `X-Auth-Request-*` identity headers, and appends its peer to
  `X-Forwarded-For` (`$proxy_add_x_forwarded_for`). Foundry trusts only that
  last hop: the client's own list, which nginx keeps in front of it, is never
  taken as the client address.
- **PKCE with S256.** `oauth2-proxy.env.example` sets
  `OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256`, so every login sends a fresh
  `code_challenge` to the provider and redeems the code with its
  `code_verifier`. An authorization code stolen on its way back to the
  callback is useless without the verifier, which never leaves oauth2-proxy.
  The production smoke test checks the challenge on the authorize redirect
  and the verifier in the token request, on the wire.
- **`FERRUM_AUTH_MODE=trusted-proxy` with `NODE_ENV=production`.** The BFF
  refuses static-token auth in production.
- **Third-party images are pinned by tag and digest**
  (`name:tag@sha256:<digest>`), so a rebuild cannot silently change what runs,
  and Dependabot (`.github/dependabot.yml`) still proposes each new
  oauth2-proxy and nginx release as a pull request. Move them in your own
  copy too: a pin that never moves collects published advisories.

### Still yours to decide

- **Which claim is the actor.** With the starter's flags, oauth2-proxy sends
  the ID token's `sub` claim as `X-Auth-Request-User`, not the email. nginx
  passes it on as `X-Forwarded-User`, and Foundry uses it as the actor: the
  admin JWT's `sub`, and so the name in Ferrum Edge's audit log and Foundry's
  own logs. The starter's production smoke test asserts this
  (`e2e/production-smoke/`). When choosing an identity provider:
  - Its `sub` must be stable for the life of the account and never reissued
    to another person. OIDC requires this, but check a provider that lets
    administrators recreate users with the same subject.
  - Many providers issue an opaque `sub` (a UUID, a number, or a value that
    differs per client application). Audit entries then name that value, not
    a person, so keep a way to map it back in the provider.
  - Moving the starter to another provider, or to another client registration
    of the same provider, can change every user's `sub`. Audit history then
    names the old values.
  - The email is a weaker actor: providers let it change and be reassigned.
    If you change what oauth2-proxy sends as `X-Auth-Request-User`, re-run the
    smoke test to see what Foundry receives.
- **A provider without PKCE.** If your provider rejects the
  `code_challenge` parameters (the login fails at the authorize or token
  step), comment out `OAUTH2_PROXY_CODE_CHALLENGE_METHOD` in
  `oauth2-proxy.env` (an empty value also turns it off) and restart
  oauth2-proxy. Logins then rely on the client secret alone to redeem a code.
  Do not switch to `plain`, which sends the verifier itself as the challenge.
- **The network range.** If `10.73.88.0/24` overlaps another Docker network,
  `up` fails with an overlapping-pool error; if it overlaps a LAN or VPN the
  host reaches, the containers lose their route to it. Set
  `FOUNDRY_STARTER_SUBNET` in `.env` to a free private IPv4 range: Compose
  uses it for both the network and oauth2-proxy's `--trusted-proxy-ip`, so
  the two never disagree. If you put another proxy in front of nginx, keep it
  off this network: oauth2-proxy should believe forwarded headers from the
  stack's own peers, not from a proxy whose headers nginx already replaces.
- **Secrets.** Plain files are the simplest thing that works; a secret manager
  that renders the same files is better.
- **Namespace grants.** `nginx/identity/policy.conf` ships one namespace and
  maps every group, including `ferrum-admins`, to it. Use exact names; Foundry
  expands no wildcards or prefixes.
- **Every starter identity is scoped.** Because each group is mapped to a
  namespace, no starter user is an unrestricted admin. A scoped session may
  reach only namespace-scoped routes plus a small fleet-wide ceiling, so it
  loses the Dashboard, Metrics, TLS, and Cluster surfaces and Mesh's fleet
  tabs (it lands on Proxies, and Mesh keeps its Trust tab), Health shows only
  the summary, and BFF settings are read-only. The Audit Log stays, for the
  session's own namespaces. See
  [`docs/authentication.md`](../../docs/authentication.md#namespace-route-ceiling).
- **Fleet-wide surfaces need a second identity.** An identity mapped to `admin`
  without a namespaces header is unrestricted and reaches TLS, Cluster,
  Metrics, Mesh, and BFF settings; only an `admin` may be global. Its JWT
  carries no `ns` claim, and the starter's gateway sets
  `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true`, so Ferrum Edge refuses it every
  namespace-scoped route: Proxies, Consumers, and the other namespace pages
  answer `403`. Give an operator who needs both a second identity rather than
  dropping the namespaces header from their only one. See
  [`docs/authentication.md`](../../docs/authentication.md#one-identity-cannot-do-both).
- **Fleet-global surfaces.** Namespace grants do not scope TLS inventory,
  managed TLS material, ACME, rotation, or validation, so a scoped identity may
  use none of them, reads included. Foundry refuses them to it, and so does
  Ferrum Edge v0.9.16+ for the `ns`-claim JWT Foundry signs.
- **Fleet-wide audit rows.** Edge records fleet-wide actions (TLS, the
  namespace registry, mesh) under its default `ferrum` namespace. Grant
  `ferrum` only to identities that may read them.
- **Gateway TLS.** The production profile assumes an `https://` admin API.
  Never set `FERRUM_TLS_VERIFY=false`.

See [`docs/deployment.md`](../../docs/deployment.md) for the full configuration
reference and production checklist.

## Teardown

```bash
docker compose --profile demo down -v          # disposable: removes its data
docker compose --profile production down       # leaves your gateway alone
```

Foundry stores nothing of its own; every resource lives in the gateway.
`down -v` leaves `.env` and `secrets/ferrum-proxy-secret.conf` in place.

`scripts/seed-demo-gateway.mjs` is **not** part of setup. It replaces a whole
namespace, which is why it requires `FERRUM_DEMO_CONFIRM_TARGET` to name the
exact target.
