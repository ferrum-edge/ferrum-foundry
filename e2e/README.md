# Critical journeys

A real browser, a production-built SPA and BFF, the documented identity-aware
proxy, a pinned real Ferrum Edge gateway, and a disposable data-plane backend.
This is the layer the unit, contract, and container gates do not join up: it is
the only place where "the operator's change actually took effect" is checked by
making a request through the gateway.

## Running it

The suite does not own the stack. It runs against the checked-in starter, with
the E2E Compose overlay supplying only the fault-forwarder address and a
test-only namespace policy. That policy adds the second admin namespace needed
to exercise isolation without widening the starter's production grant.

```bash
# 1. The stack, with the BFF reaching the gateway through the forwarder.
cd deploy/starter && ./bootstrap-demo.sh && cd ../..
docker compose -f deploy/starter/compose.yaml -f e2e/compose.e2e.yaml \
  --profile demo up -d --wait

# 2. The fault forwarder, on the host.
FAULT_UPSTREAM=http://127.0.0.1:9000 FAULT_TOKEN=e2e-fault-token \
  npm run e2e:fault-proxy &

# 3. The journeys.
FOUNDRY_URL=http://127.0.0.1:8088 \
FERRUM_DATA_PLANE_URL=http://127.0.0.1:8000 \
FAULT_TOKEN=e2e-fault-token \
  npm run e2e

npm run e2e:report   # the HTML report from the last run
```

The same three steps run in CI. Nothing about the suite is CI-only.

## What each journey is for

| File | The question it answers |
| --- | --- |
| `first-route.spec.ts` | Can an admin go from nothing to a route that refuses anonymous callers and serves authenticated ones? |
| `authorization.spec.ts` | Can anyone reach a surface they were not granted — unauthenticated, unmapped, or by sending their own identity headers? |
| `namespace-isolation.spec.ts` | Can one tenant's configuration appear under another, across switches and a failed read? |
| `lifecycle.spec.ts` | Does an edit or a delete leave the gateway in the state the UI claimed? |
| `read-failures.spec.ts` | Does a transient failure recover quietly, and does an unavailable read stay distinguishable from an empty one? |
| `interrupted-write.spec.ts` | When the outcome of a write is genuinely unknown, is it reported rather than replayed? |

## Rules the suite holds itself to

**No retries.** `retries: 0`. A journey that needs a second attempt to go green
is telling us something, and a release gate that can pass by repetition is not
a gate.

**Failures are arranged, not awaited.** `fault-proxy.mjs` sits between the BFF
and the gateway and fails exactly the next N requests matching a method and
path. Journeys assert their armed faults were *consumed*, so one cannot pass
because the failure it arranged never happened.

**The gateway is the witness.** Every claim the UI makes is read back from the
gateway, and the route journeys finish with real data-plane requests. A save
that rendered green is not evidence.

**The gate proves it is live.** `npm run e2e:gate-self-test` makes the
forwarder answer `POST /consumers` with a fabricated `201` that never reaches
the gateway — the UI shows success, the gateway holds nothing — and requires
the critical journey's consumer step to fail on its gateway read-back. It also
requires that the fault was actually triggered, that global setup succeeded,
and that the steps before the break passed, so a run that dies early for an
unrelated reason cannot pass as proof. The fault is armed by the suite's own
global setup (`FERRUM_E2E_SELF_TEST_FAULT`), because setup disarms the
forwarder and would clear anything armed before it.

**Faults can be late, or tenant-specific.** Besides failing, the forwarder can
hold a request (`delayMs`) and forward it afterwards, and can match only
requests bound to one namespace (`namespace`) — which is how the isolation
journey delivers tenant A's answer after the operator has switched to B,
without also slowing B's own read.

## Adding a journey

Ask what an operator would be misled about if it broke, and assert against the
gateway or the data plane rather than against the page. If it needs a failure,
arm it and assert it was consumed. If it needs a role, use `signIn(identity)`
so the real group-to-role policy decides what that identity can do.
