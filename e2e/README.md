# Critical journeys

A real browser (Chromium) drives the production-built SPA and BFF, behind the
starter's identity-aware proxy, in front of the pinned Ferrum Edge gateway and a
disposable data-plane backend. Unit, contract, and container gates each test a
piece; this suite is the only place that checks an operator's change took effect
by sending a request through the gateway.

## Running it

The suite does not start the stack. It runs against the checked-in starter
(`deploy/starter/`) with the `e2e/compose.e2e.yaml` overlay, which:

- points the BFF at the fault forwarder on the host (`host.docker.internal:9500`)
  instead of the gateway;
- mounts a test-only identity policy (`e2e/nginx/policy.conf`) that grants the
  admin a second namespace, `ferrum-foundry-demo-b`, for the isolation journeys.
  The starter's own policy is not widened.

```bash
# 1. The stack. To test a local build, set FOUNDRY_IMAGE before bootstrapping
#    (it is written to .env). Left unset, it is written empty and compose.yaml
#    falls back to the published release digest it pins, not your changes.
(cd deploy/starter && ./bootstrap-demo.sh)
docker compose -f deploy/starter/compose.yaml -f e2e/compose.e2e.yaml \
  --profile demo up -d --wait

# 2. The fault forwarder, on the host (listens on :9500 by default).
FAULT_UPSTREAM=http://127.0.0.1:9000 FAULT_TOKEN=e2e-fault-token \
  npm run e2e:fault-proxy &

# 3. The journeys, then the gate self-test.
FAULT_TOKEN=e2e-fault-token npm run e2e
FAULT_TOKEN=e2e-fault-token npm run e2e:gate-self-test

npm run e2e:report   # HTML report from the last run
```

`e2e/support/stack.ts` defaults the rest to the starter's ports: `FOUNDRY_URL`
(`http://127.0.0.1:8088`), `FERRUM_DATA_PLANE_URL` (`:8000`), and
`FAULT_PROXY_URL` (`:9500`). The journeys reach the gateway only through
Foundry, the same front door the browser uses, so they need no admin API URL.
CI runs the same steps in the **Critical Journeys** job, against an image built
from the commit.

## What each journey is for

| File (`e2e/journeys/`) | The question it answers |
| --- | --- |
| `first-route.spec.ts` | Can an admin go from nothing to a route that refuses anonymous callers and serves authenticated ones? |
| `authorization.spec.ts` | Can anyone reach a surface they were not granted — unauthenticated, unmapped, or by sending their own identity headers? Is a read the gateway withholds from a role shown as a denial rather than as empty data? |
| `namespace-isolation.spec.ts` | Can one tenant's configuration appear under another — including when both namespaces hold the same id — across reads, writes, deletes, switches, and a late or failed read? |
| `lifecycle.spec.ts` | Does an edit or a delete leave the gateway in the state the UI claimed? |
| `read-failures.spec.ts` | Does a transient failure recover quietly, and does an unavailable read stay distinguishable from an empty one? |
| `interrupted-write.spec.ts` | When the outcome of a write is genuinely unknown, is it reported rather than replayed? |
| `content-security-policy.spec.ts` | Do the styles Radix injects at runtime (scroll lock, Select viewport) apply under a `style-src` with no `'unsafe-inline'`, with no CSP violation? |

## Rules the suite holds itself to

**No retries.** `retries: 0`, one worker. A release gate that can pass by
repetition is not a gate.

**Failures are arranged, not awaited.** `e2e/fault-proxy.mjs` sits between the
BFF and the gateway admin API. A journey arms a rule through `/__fault` (guarded
by `x-fault-token`) that affects exactly the next N requests matching a method
and path prefix, and can be limited to one namespace. A rule can:

- answer with a chosen status and body without reaching the gateway;
- `drop` the request before the gateway sees it;
- `dropAfterForward`: let the write commit, then cut the connection;
- `delayMs`: hold the request, then forward it (a late answer).

Journeys assert their armed faults were consumed, so a journey cannot pass
because its failure never happened. The `faults` fixture disarms the forwarder
before and after each test that uses it.

**The gateway is the witness.** Every claim the UI makes is read back from the
gateway, and route journeys finish with real data-plane requests. A save that
rendered green is not evidence.

**The gate proves it is live.** `npm run e2e:gate-self-test`
(`scripts/e2e-gate-self-test.mjs`) makes the forwarder answer `POST /consumers`
with a fabricated `201` that never reaches the gateway, and requires the
critical journey's consumer step to fail on its gateway read-back. It also
requires that the fault fired, that global setup succeeded, and that the steps
before the break passed, so a run that dies early for another reason is not
accepted as proof. The fault is armed by global setup
(`FERRUM_E2E_SELF_TEST_FAULT`), because setup disarms the forwarder and would
clear anything armed earlier.

## Adding a journey

Ask what an operator would be misled about if it broke, and assert against the
gateway or the data plane rather than the page. If it needs a failure, arm it
and assert it was consumed. If it needs a role, use `signIn(identity)`
(`admin`, `operator`, `viewer`, or `unmapped`) so the real group-to-role policy
decides what that identity can do.

## The production profile

The journeys run the starter's `demo` profile, whose identity provider is an
nginx stub. `e2e/production-smoke/` runs the `production` profile as shipped:
nginx terminating TLS, oauth2-proxy owning an OIDC login, and Foundry behind
both. Its overlay (`e2e/production-smoke/compose.yaml`) adds a mock OIDC
provider and changes no shipped service, and `run.sh configure` writes only the
files an operator fills in (`.env` and `oauth2-proxy.env` from their examples,
the proxy-proof include, and a certificate from a CA generated for the run).

```bash
export FOUNDRY_IMAGE=ferrum-foundry:ci   # optional: the image to test
e2e/production-smoke/run.sh configure    # refuses to overwrite existing files
e2e/production-smoke/run.sh up
e2e/production-smoke/run.sh verify       # needs curl, jq, node, and sudo tcpdump
e2e/production-smoke/run.sh down
```

`verify` logs in with curl and a cookie jar and checks that:

- an unauthenticated page load is redirected to the provider's authorize
  endpoint, with `code_challenge_method=S256` and an S256 `code_challenge`
  (PKCE, from `oauth2-proxy.env.example`), and an unauthenticated API call
  gets a bare `401`;
- every login sends its own `code_challenge`, and the admin login's token
  request, read off the wire between oauth2-proxy and the provider
  (`pkce.mjs`), redeems the code with a `code_verifier` whose S256 digest is
  that challenge. The mock provider also refuses a token request without the
  matching verifier, so every completed login is evidence too;
- a completed login reaches Foundry with the identity the shared policy maps
  the user's groups to (`/api/auth/session`; the actor is the ID token's
  `sub`, which oauth2-proxy sends as `X-Auth-Request-User`), a user in several
  groups gets the Ferrum one, and a user in no Ferrum group is refused at
  login;
- with spoofed `X-Forwarded-*`, `X-Real-IP`, `X-Auth-Request-Redirect`,
  `X-Request-Id`, and identity headers on the request, the session is
  unchanged. Reading nginx's upstream traffic off the wire with `tcpdump`
  (`forwarded-headers.mjs`), the requests to oauth2-proxy carry exactly one of
  each forwarded header it reads, with nginx's own value, on `/oauth2/start`
  and on the `/oauth2/auth` subrequest. `X-Auth-Request-Redirect` is the
  request URI on `/oauth2/start` and absent on the subrequest, and the BFF's
  `X-Ferrum-Auth-Secret`, `X-Forwarded-User`, `X-Ferrum-Role`, and
  `X-Ferrum-Namespaces` headers are absent on both `/oauth2/start` and
  `/oauth2/auth`. Foundry
  receives nginx's `X-Forwarded-Host`, `-Proto` and `X-Real-IP`, an
  `X-Forwarded-For` ending with nginx's peer, and no `X-Forwarded-Uri`,
  `X-Auth-Request-Redirect`, or oauth2-proxy `X-Auth-Request-*` identity
  header. Both upstreams receive nginx's `$request_id` as `X-Request-Id`.
  Neither oauth2-proxy's log nor Foundry's may name a spoofed value, and a log
  that cannot be read fails;
- oauth2-proxy believes `X-Forwarded-*` only from the stack's network.
  The running network's subnet and oauth2-proxy's `--trusted-proxy-ip` must
  both equal the subnet Compose renders (`docker compose config`), which
  resolves `FOUNDRY_STARTER_SUBNET` from the shell or the starter's `.env`
  (`10.73.88.0/24` by default). `direct-probe.mjs`,
  run in a throwaway container of the Foundry image, then asks oauth2-proxy
  directly to start a login with a forged `X-Forwarded-Uri`,
  `X-Forwarded-Host` and `X-Real-IP`: once from the stack's network, where
  the forged path becomes the post-login redirect (carried in the authorize
  redirect's `state`) and the forged host and address appear in
  oauth2-proxy's log, and once from a network outside the range
  (`foundry-smoke-outside`, attached to oauth2-proxy for that probe only),
  where the redirect stays `/` and the log names neither. Docker allocates
  that network's subnet, and the check fails before the probe unless it is
  disjoint from the trusted range.

Every forwarded and identity value the probes forge carries a marker string,
except the role, which is an enum; `X-Ferrum-Role` is checked by absence at
oauth2-proxy, and the session check shows the client's role is ignored at
Foundry. Any other header carrying a marker fails at Foundry. At oauth2-proxy
it is printed as a note, because oauth2-proxy reads only the headers checked
above. A client header without a marker is not detected unless it is required
to be absent.

CI runs this as the **Starter Production Profile** job, against the image built
from the commit, and prints every container's logs when it fails.
