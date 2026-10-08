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

**Published pairing.** The demo profile pins published Edge v0.9.14, qualified
with published Foundry v0.5.3. The
[v0.5.3 record](../../docs/release-notes/v0.5.3.compatibility.json) preserves
the published source `74a7be374f5c6fcf1284737907e43d8808bb95c6`, hosted
[qualification run 37758405759](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37758405759)
(source `e88b8341`, tested merge `885934d6`), and actual
[publication run 37760444063](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/37760444063)
(published 2026-10-08 at 10:07:37 UTC). The default Foundry image is pinned to
`ferrumedge/ferrum-foundry@sha256:1edef8251f7786f10ebb67dd333cf9e75f7bf54f7af17ad4452227df3ac9a742`;
set `FOUNDRY_IMAGE` to another released digest when selecting a different
pairing. Both profiles and authority tiers are unchanged. This release adopts
published `contracts-edge-0.9.14` at
`ddbdd845733b7046c4393ac951011dafb774db33`; its service-manifest schema and all
manifest fixtures are unchanged from the prior pin. The native deployment
profile is not adopted.

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
| `compose.yaml` | Both profiles. Third-party images are pinned by digest |
| `.env.example` | Foundry and gateway inputs, with placeholders. No working secrets |
| `oauth2-proxy.env.example` | Identity-provider settings, read by oauth2-proxy alone |
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

FERRUM_ADMIN_URL=http://127.0.0.1:9000 \
FOUNDRY_PREFLIGHT_URL=http://127.0.0.1:8088 \
node ../../scripts/starter-preflight.mjs --env .env
```

Then open <http://127.0.0.1:8088> and follow
[`docs/getting-started.md`](../../docs/getting-started.md).

`bootstrap-demo.sh` also sets `FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true`, so the
BFF may reach the throwaway gateway over plaintext on the compose network.
Without it, Foundry refuses a plaintext admin URL to any host but loopback;
the production `.env` leaves it `false` and uses `https`.

The demo publishes only loopback ports (`FOUNDRY_DEMO_PORT` 8088,
`FERRUM_DEMO_PROXY_PORT` 8000, `FERRUM_DEMO_ADMIN_PORT` 9000), and its identity
stub trusts a request header (`X-Demo-Identity: admin`, `operator`, `viewer`,
or `unmapped`). It is for a first run and for CI. Do not expose it.

## Production

1. `cp .env.example .env` and `cp oauth2-proxy.env.example oauth2-proxy.env`,
   fill both in, and `chmod 600` both. Generate secrets with
   `openssl rand -base64 48`. `FERRUM_JWT_SECRET` must equal the gateway's
   `FERRUM_ADMIN_JWT_SECRET`.

   The files are separate on purpose. `.env` holds the gateway signing key and
   the proof secret; `oauth2-proxy.env` holds the `OAUTH2_PROXY_*` settings,
   which oauth2-proxy reads directly. Each service gets only its own file.
   (The IdP settings are not Compose variables because Compose interpolates the
   whole file for every profile, and a production-only requirement would stop
   the demo from starting.)
2. Write `secrets/ferrum-proxy-secret.conf` with the **same** value as
   `FERRUM_TRUSTED_PROXY_SECRET`:

   ```bash
   printf 'set $ferrum_proxy_secret "%s";\n' "$FERRUM_TRUSTED_PROXY_SECRET" \
     > secrets/ferrum-proxy-secret.conf
   chmod 600 secrets/ferrum-proxy-secret.conf
   ```

   This keeps the secret out of the checked-in nginx configuration.
3. Put your certificate and key in `tls/` (`foundry.crt`, `foundry.key`). If
   the gateway presents a private certificate, put its CA in `ca/` and set
   `FERRUM_TLS_CA_ROOT=/etc/ferrum/ca` and `FERRUM_TLS_CA_PATH` in `.env`.
4. Edit `nginx/foundry.conf` for your `server_name` and certificate paths, and
   `nginx/identity/policy.conf` for your IdP's group names and your namespaces.
5. Pin `FOUNDRY_IMAGE` to a released digest, and run the Ferrum Edge release
   named in that published pairing's immutable record linked from
   [`docs/compatibility.md`](../../docs/compatibility.md).
6. `docker compose --profile production up -d`, then run the preflight.

### What the stack gets right

- **The BFF publishes no host port.** Anyone who can reach it and knows the
  proof secret is a gateway administrator, so only the proxy is published.
- **All four identity headers are set with `proxy_set_header`,** which replaces
  any client-supplied copy. Without that, a browser could send
  `X-Ferrum-Role: admin`.
- **An unmapped user is denied twice:** by oauth2-proxy's `--allowed-group` at
  login, and by the empty `map` default, which asserts no role.
- **`FERRUM_AUTH_MODE=trusted-proxy` with `NODE_ENV=production`.** The BFF
  refuses static-token auth in production.
- **Third-party images are pinned by digest**, so a rebuild cannot silently
  change what runs.

### Still yours to decide

- **Secrets.** Plain files are the simplest thing that works; a secret manager
  that renders the same files is better.
- **Namespace grants.** `nginx/identity/policy.conf` ships one namespace and
  maps every group, including `ferrum-admins`, to it. Use exact names; Foundry
  expands no wildcards or prefixes.
- **Every starter identity is scoped.** Because each group is mapped to a
  namespace, no starter user is an unrestricted admin. A scoped session may
  reach only namespace-scoped routes plus a small fleet-wide ceiling, so it
  loses the Dashboard, Metrics, Cluster, and Mesh surfaces, and Health shows
  only the summary. The Audit Log stays, for the session's own namespaces. To
  give one operator the fleet-wide surfaces, map that identity to a role but
  omit its namespaces header; only an `admin` may be global. See
  [`docs/authentication.md`](../../docs/authentication.md#namespace-route-ceiling).
- **Fleet-global surfaces.** Namespace grants do not scope TLS inventory,
  managed TLS material, ACME, rotation, or validation. A scoped identity may
  read and validate fleet TLS material but may not create, replace, rotate,
  renew, finalize, or delete it; restrict the reads at the proxy as well if a
  scoped identity must not see them.
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
