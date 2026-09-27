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
#    (it is written to .env; the default is ferrumedge/ferrum-foundry:main).
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
(`http://127.0.0.1:8088`), `FERRUM_DATA_PLANE_URL` (`:8000`), `FERRUM_ADMIN_URL`
(`:9000`), and `FAULT_PROXY_URL` (`:9500`). CI runs the same steps in the
**Critical Journeys** job, against an image built from the commit.

## What each journey is for

| File (`e2e/journeys/`) | The question it answers |
| --- | --- |
| `first-route.spec.ts` | Can an admin go from nothing to a route that refuses anonymous callers and serves authenticated ones? |
| `authorization.spec.ts` | Can anyone reach a surface they were not granted — unauthenticated, unmapped, or by sending their own identity headers? Is a read the gateway withholds from a role shown as a denial rather than as empty data? |
| `namespace-isolation.spec.ts` | Can one tenant's configuration appear under another — including when both namespaces hold the same id — across reads, writes, deletes, switches, and a late or failed read? |
| `lifecycle.spec.ts` | Does an edit or a delete leave the gateway in the state the UI claimed? |
| `read-failures.spec.ts` | Does a transient failure recover quietly, and does an unavailable read stay distinguishable from an empty one? |
| `interrupted-write.spec.ts` | When the outcome of a write is genuinely unknown, is it reported rather than replayed? |

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
