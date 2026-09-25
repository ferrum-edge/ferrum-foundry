/* ------------------------------------------------------------------ */
/*  Two-session concurrent-edit contract (issue #381)                  */
/* ------------------------------------------------------------------ */

/**
 * Runs the two-administrator regression against a real pinned Ferrum Edge
 * gateway and records what actually happens, in this order:
 *
 *   1. Two editors open the same proxy and keep their own draft.
 *   2. Administrator 1 repoints the backend and the gateway accepts it.
 *   3. Administrator 2 submits the older draft **without** the guard. This is
 *      the baseline: the gateway accepts it and administrator 1's change is
 *      gone. It is what any other admin-API client still does.
 *   4. The same older draft is submitted **through the guard**. It is refused
 *      before anything reaches the wire and the newer value survives.
 *   5. The precondition itself. The guard sends the `ETag` of its verification
 *      read as `If-Match` (ferrum-edge#5661), which is what closes the gap
 *      between that read and the write. A gateway that tags reads must refuse
 *      a tag from before administrator 1's change, and an invented one, with
 *      `412` and write nothing, and must refuse a malformed `If-Match` and
 *      one on a create with `400` (Edge v0.9.7), never apply them as if the
 *      header were absent. A gateway that issues no tag gets no `If-Match`
 *      from Foundry, so it must not be enforcing one either — either
 *      mismatch means Foundry's guard and the gateway disagree about the
 *      contract (see `docs/concurrent-edits.md`).
 *
 * The comparison uses `src/lib/resourceBaseline.ts` directly — the same module
 * the browser uses — so the contract cannot pass against a second copy of the
 * rules that has drifted from the shipped one.
 */

import assert from "node:assert/strict";
import {
  baselineSnapshot,
  resourceFingerprint,
  PROXY_BASELINE_OMIT,
} from "../src/lib/resourceBaseline.ts";

const PROXY_ID = "concurrent-edit-contract-proxy";
const CREATE_PROBE_ID = "concurrent-edit-contract-create-probe";
const BACKEND_A = "backend-a.contract.invalid";
const BACKEND_B = "backend-b.contract.invalid";

function fingerprint(proxy) {
  return resourceFingerprint(baselineSnapshot(proxy, PROXY_BASELINE_OMIT));
}

/** Strip the fields a full-replacement PUT never carries. */
function toUpdatePayload(proxy) {
  const { created_at, updated_at, namespace, api_spec_id, ...rest } = proxy;
  void created_at;
  void updated_at;
  void namespace;
  void api_spec_id;
  return rest;
}

/** RFC 9110 strong entity-tag, as `strongEtag()` in `conditionalWrite.ts`. */
function strongEtag(header) {
  const value = header?.trim();
  return value && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}

/**
 * The guard, expressed against the raw admin API exactly as
 * `src/api/conditionalWrite.ts` expresses it against the BFF: verify against
 * the baseline, then write conditionally on the tag of that same read.
 */
async function guardedPut(exchange, baseline, body) {
  const fresh = await exchange(`/proxies/${PROXY_ID}`);
  assert.equal(fresh.status, 200, "verification read failed");
  if (fingerprint(fresh.body) !== fingerprint(baseline)) {
    return { refused: true, current: fresh.body };
  }
  const etag = strongEtag(fresh.etag);
  const written = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
    method: "PUT",
    body,
    ...(etag && { headers: { "if-match": etag } }),
  });
  assert.equal(written.status, 200, `guarded PUT returned ${written.status}`);
  return { refused: false, current: written.body };
}

/**
 * @param exchange  `(path, { method, body, headers }) => { status, body }`
 *                  bound to one namespace, as `gateway-contract-smoke.mjs`
 *                  builds it.
 * @param proxyTemplate a complete, admissible proxy body for this gateway.
 */
export async function verifyConcurrentEditContract(exchange, proxyTemplate) {
  const created = await exchange("/proxies?apply=sync", {
    method: "POST",
    body: {
      ...proxyTemplate,
      id: PROXY_ID,
      name: "Concurrent edit contract",
      listen_path: "/concurrent-edit-contract",
      upstream_id: null,
      backend_host: BACKEND_A,
      backend_read_timeout_ms: 5_000,
      plugins: [],
    },
  });
  assert.ok(
    [200, 201].includes(created.status),
    `proxy create returned ${created.status}: ${JSON.stringify(created.body)}`,
  );

  const findings = {};
  try {
    // ── 1. Both editors open against the same content ──────────────
    const opened = await exchange(`/proxies/${PROXY_ID}`);
    assert.equal(opened.status, 200);
    const seed = opened.body;
    assert.equal(seed.backend_host, BACKEND_A);

    // Administrator 2's draft: the timeout only, on top of what they opened.
    const staleDraft = { ...toUpdatePayload(seed), backend_read_timeout_ms: 30_000 };
    // Administrator 1's change.
    const newerChange = { ...toUpdatePayload(seed), backend_host: BACKEND_B };

    // ── 2. Administrator 1 saves through the guard ─────────────────
    const first = await guardedPut(exchange, seed, newerChange);
    assert.equal(first.refused, false, "administrator 1 was refused unexpectedly");
    assert.equal(first.current.backend_host, BACKEND_B);

    // ── 3. Baseline: the unguarded stale write is accepted ─────────
    const unguarded = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
      method: "PUT",
      body: staleDraft,
    });
    assert.equal(unguarded.status, 200);
    assert.equal(
      unguarded.body.backend_host,
      BACKEND_A,
      "gateway did not revert the newer value; re-read the precondition survey",
    );
    findings.unguardedStaleWriteReverts = true;

    // ── 4. The guard refuses the same draft ────────────────────────
    const restored = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
      method: "PUT",
      body: newerChange,
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.backend_host, BACKEND_B);

    const second = await guardedPut(exchange, seed, staleDraft);
    assert.equal(second.refused, true, "the guard admitted a stale draft");
    findings.guardedStaleWriteRefused = true;

    const after = await exchange(`/proxies/${PROXY_ID}`);
    assert.equal(
      after.body.backend_host,
      BACKEND_B,
      "the refused write still reached the gateway",
    );
    assert.equal(after.body.backend_read_timeout_ms, 5_000);

    // ── 5. The precondition the guard sends ────────────────────────
    const openedTag = strongEtag(opened.etag);
    findings.gatewayIssuesEtag = openedTag !== null;

    if (openedTag) {
      const current = await exchange(`/proxies/${PROXY_ID}`);
      assert.notEqual(
        strongEtag(current.etag),
        openedTag,
        "the tag did not change after an accepted write",
      );

      // Administrator 2's tag predates administrator 1's change.
      const stale = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
        method: "PUT",
        body: staleDraft,
        headers: { "if-match": openedTag },
      });
      assert.equal(stale.status, 412, `a stale If-Match returned ${stale.status}`);

      const invented = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
        method: "PUT",
        body: staleDraft,
        headers: { "if-match": '"a-revision-this-proxy-never-had"' },
      });
      assert.equal(invented.status, 412, `an invented If-Match returned ${invented.status}`);

      // A malformed header is a 400, never read as "no precondition".
      const malformed = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
        method: "PUT",
        body: staleDraft,
        headers: { "if-match": "a-tag-without-quotes" },
      });
      assert.equal(malformed.status, 400, `a malformed If-Match returned ${malformed.status}`);
      findings.malformedIfMatchStatus = malformed.status;

      // A create does not evaluate If-Match, so carrying one is a 400 rather
      // than an unconditional write. Foundry never sends one there.
      const create = await exchange("/proxies?apply=sync", {
        method: "POST",
        body: {
          ...proxyTemplate,
          id: CREATE_PROBE_ID,
          name: "Concurrent edit contract create probe",
          listen_path: "/concurrent-edit-contract-create-probe",
          upstream_id: null,
          backend_host: BACKEND_A,
          plugins: [],
        },
        headers: { "if-match": '"a-revision-this-proxy-never-had"' },
      });
      assert.equal(create.status, 400, `If-Match on a create returned ${create.status}`);
      findings.createIfMatchStatus = create.status;
      const notCreated = await exchange(`/proxies/${CREATE_PROBE_ID}`);
      assert.equal(notCreated.status, 404, "a create refused for its If-Match still wrote");

      const survived = await exchange(`/proxies/${PROXY_ID}`);
      assert.equal(survived.body.backend_host, BACKEND_B, "a refused conditional write reached the gateway");
      assert.equal(survived.body.backend_read_timeout_ms, 5_000);
      findings.ifMatchStatus = stale.status;
      findings.gatewayHonoursIfMatch = true;
    } else {
      // No tag, so Foundry sends no If-Match and the guard is the
      // verification read alone. The gateway must not be enforcing a
      // precondition Foundry cannot satisfy.
      const precondition = await exchange(`/proxies/${PROXY_ID}?apply=sync`, {
        method: "PUT",
        body: newerChange,
        headers: { "if-match": '"a-revision-this-proxy-never-had"' },
      });
      findings.ifMatchStatus = precondition.status;
      findings.gatewayHonoursIfMatch = precondition.status === 412;
      assert.notEqual(
        precondition.status,
        412,
        "the gateway enforces If-Match but issued no ETag on the read, so " +
          "Foundry's guard cannot send one — see docs/concurrent-edits.md",
      );
    }
  } finally {
    await exchange(`/proxies/${PROXY_ID}?apply=sync&cleanup_orphaned_upstream=false`, {
      method: "DELETE",
    });
    // Only present if the gateway wrongly accepted the create probe.
    await exchange(`/proxies/${CREATE_PROBE_ID}?apply=sync&cleanup_orphaned_upstream=false`, {
      method: "DELETE",
    });
  }

  return findings;
}
