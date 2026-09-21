# Ferrum Foundry starter

A runnable version of the topology in [`docs/deployment.md`](../../docs/deployment.md):

```
browser -> reverse proxy (the only published port) -> Foundry BFF -> Ferrum Edge
```

The reverse proxy owns TLS and the OIDC login, maps identity-provider groups to
a Ferrum role and namespace grants, and asserts them to Foundry. Foundry turns
that assertion into the `sub`, `role`, and `ns` claims of the admin JWT it signs
per request.

For the walkthrough that ends in an authenticated request through the data
plane, see [`docs/getting-started.md`](../../docs/getting-started.md).

## Two profiles

| | `production` | `demo` |
| --- | --- | --- |
| Reverse proxy | nginx, TLS on :443 | nginx, plain HTTP on loopback |
| Identity | oauth2-proxy against your OIDC provider | a local stub keyed by a request header |
| Gateway | yours | a disposable SQLite Ferrum Edge |
| Backend | yours | a disposable echo origin |
| Data | yours | throwaway; `down -v` removes it |

**Everything below the identity source is the same in both.** The
group-to-role policy (`nginx/identity/policy.conf`) and the four identity
headers (`nginx/identity/inject.conf`) are included by both configurations, so
the demo exercises the real authorization path rather than a look-alike. A test
(`scripts/starter-preflight.test.mjs`) fails if either config grows its own
copy.

## Files

| Path | What it is |
| --- | --- |
| `compose.yaml` | Both profiles. Third-party images are pinned by digest |
| `.env.example` | Every input, with placeholders. No working secrets |
| `bootstrap-demo.sh` | Generates throwaway demo secrets; refuses to overwrite an existing `.env` |
| `nginx/foundry.conf` | Production reverse proxy |
| `nginx/foundry.demo.conf` | Demo reverse proxy plus the stub identity provider |
| `nginx/identity/policy.conf` | Group → role and group → namespace policy (**shared**) |
| `nginx/identity/inject.conf` | The four identity headers (**shared**) |
| `secrets/`, `tls/`, `ca/` | Mount points. Contents are git-ignored |

## Demo

```bash
./bootstrap-demo.sh
docker compose --profile demo up -d

FERRUM_ADMIN_URL=http://127.0.0.1:9000 \
FOUNDRY_PREFLIGHT_URL=http://127.0.0.1:8088 \
node ../../scripts/starter-preflight.mjs --env .env
```

Then open <http://127.0.0.1:8088> and follow
[`docs/getting-started.md`](../../docs/getting-started.md).

The demo stack publishes only loopback ports and its identity stub trusts a
request header. It is for a first run and for CI. Do not expose it.

## Production

1. `cp .env.example .env`, fill it in, `chmod 600 .env`. Generate secrets with
   `openssl rand -base64 48`. `FERRUM_JWT_SECRET` must equal the gateway's
   `FERRUM_ADMIN_JWT_SECRET`.
2. Write `secrets/ferrum-proxy-secret.conf` with the **same** value as
   `FERRUM_TRUSTED_PROXY_SECRET`:

   ```bash
   printf 'set $ferrum_proxy_secret "%s";\n' "$FERRUM_TRUSTED_PROXY_SECRET" \
     > secrets/ferrum-proxy-secret.conf
   chmod 600 secrets/ferrum-proxy-secret.conf
   ```

   The secret is kept out of the checked-in nginx configuration on purpose, and
   out of the BFF's `env_file` so the OAuth client secret never reaches it.
3. Put your certificate and key in `tls/`, and the gateway's CA in `ca/` if it
   presents a private certificate.
4. Edit `nginx/foundry.conf` for your `server_name` and certificate paths, and
   `nginx/identity/policy.conf` for your IdP's group names and your namespaces.
5. Pin `FOUNDRY_IMAGE` to a released digest.
6. `docker compose --profile production up -d`, then run the preflight.

### Things this stack gets right, and why

- **The BFF publishes no host port.** Anyone who can reach it and knows the
  proof secret is a gateway administrator. Only the proxy is published.
- **All four identity headers are set with `proxy_set_header`,** which replaces
  any client-supplied copy. That is the stripping guarantee as much as the
  injection: without it a browser could send `X-Ferrum-Role: admin`.
- **An unmapped user is denied twice** — by oauth2-proxy's `--allowed-group` at
  login, and by the empty `map` default, which asserts no role so Foundry
  refuses the request.
- **`FERRUM_AUTH_MODE=trusted-proxy` with `NODE_ENV=production`.** Static-token
  authentication is development-only and the BFF refuses it in production.
- **Third-party images are pinned by digest**, so a rebuild cannot silently
  change what runs.

### Still yours to decide

- Where secrets come from. The files here are the simplest thing that works;
  a secret manager rendering the same files is strictly better.
- Namespace grants. `nginx/identity/policy.conf` ships one namespace. Real
  grants are exact names — Foundry expands no wildcards or prefixes.
- Fleet-global surfaces. Namespace grants do not scope TLS inventory, managed
  TLS material, ACME, rotation, or validation. Restrict those routes at the
  proxy when a scoped identity must not reach them.
- TLS to the gateway. The production profile assumes an `https://` admin API.
  Never set `FERRUM_TLS_VERIFY=false`.

## Teardown

```bash
docker compose --profile demo down -v          # disposable: removes its data
docker compose --profile production down       # leaves your gateway alone
```

Foundry stores nothing of its own — no database, no migrations. Every resource
lives in the gateway.

`scripts/seed-demo-gateway.mjs` is **not** part of setup. It replaces the
contents of a namespace and requires `FERRUM_DEMO_CONFIRM_TARGET` to equal its
exact target for that reason.
