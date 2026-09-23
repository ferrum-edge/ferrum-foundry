/* ------------------------------------------------------------------ */
/*  Conditional full-replacement writes (ferrum-edge#5661)             */
/* ------------------------------------------------------------------ */

/**
 * Ferrum Edge tags `GET /proxies/{id}` and `GET /upstreams/{id}` with a strong
 * `ETag` and refuses a `PUT` whose `If-Match` no longer matches with `412`,
 * atomically with the write. These tests pin how Foundry uses that contract:
 * the tag always comes from the read the guard just verified, a writer that
 * commits in the gap between that read and the `PUT` is refused rather than
 * overwritten, and a gateway without the contract still gets the
 * verification-read guard alone.
 *
 * The stub below implements the contract as `docs/admin_api.md` states it —
 * a tag over the whole stored resource (plugin associations included), strong
 * comparison only, and an unconditional write when `If-Match` is absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStaleResourceError,
  PRECONDITION_ATTEMPTS,
  strongEtag,
} from "./conditionalWrite";
import { setApiErrorHandler } from "./client";
import { resetGatewayMetadata } from "./gatewayMetadata";
import * as proxies from "./proxies";
import * as upstreams from "./upstreams";
import type { Proxy, ProxyCreate, Upstream } from "./types";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

const scope = { namespace: "tenant-a" };

interface GatewayOptions {
  /** How the gateway tags a read: strong (Edge), none (older Edge), or weak. */
  readonly tags?: "strong" | "none" | "weak";
  /** Another writer, committing after the verification read and before the PUT. */
  readonly interleave?: (stored: Record<string, unknown>) => Record<string, unknown>;
  /** How many PUTs the interleaved writer races. */
  readonly interleaveTimes?: number;
  /** Status to answer a conditional PUT with instead of evaluating it. */
  readonly failConditionalWith?: number;
}

function stubGateway<T extends object>(seed: T, options: GatewayOptions = {}) {
  let stored = { ...seed } as Record<string, unknown>;
  let revision = 0;
  let interleaves = options.interleaveTimes ?? 1;
  const wire: string[] = [];
  const tag = () => `"r${revision}"`;

  const commit = (next: Record<string, unknown>) => {
    revision += 1;
    stored = { ...next, updated_at: `rev-${revision}` };
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const ifMatch = request.headers.get("if-match");
      wire.push(
        `${request.method}${ifMatch === null ? "" : ` if-match ${ifMatch}`}`,
      );

      if (request.method === "GET") {
        const headers = new Headers();
        if (options.tags !== "none") {
          headers.set("etag", options.tags === "weak" ? `W/${tag()}` : tag());
        }
        return Response.json(stored, { headers });
      }

      if (options.interleave && interleaves > 0) {
        interleaves -= 1;
        commit(options.interleave(stored));
      }
      if (ifMatch !== null && options.failConditionalWith) {
        return Response.json({ error: "bad request" }, { status: options.failConditionalWith });
      }
      // Strong comparison: a weak tag never matches.
      if (ifMatch !== null && ifMatch !== tag()) {
        return Response.json({ error: "Precondition Failed" }, { status: 412 });
      }
      // Full replacement, except that an omitted `plugins` key preserves the
      // live associations, exactly as Edge does for a proxy PUT.
      const body = (await request.json()) as Record<string, unknown>;
      commit({ ...body, ...(!("plugins" in body) && { plugins: stored.plugins }) });
      return Response.json(stored);
    }),
  );

  return { wire, read: () => stored as T };
}

function proxyFixture(): Proxy {
  return {
    id: "checkout",
    namespace: "tenant-a",
    name: "checkout",
    hosts: ["checkout.example.com"],
    backend_scheme: "https",
    backend_host: "backend-a.internal",
    backend_port: 8443,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 2_000,
    backend_read_timeout_ms: 5_000,
    backend_write_timeout_ms: 5_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: true,
    passthrough: false,
    udp_idle_timeout_seconds: 30,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** What ProxyForm submits: every writable field except `plugins`. */
function formDraft(proxy: Proxy, changes: Partial<ProxyCreate>): ProxyCreate {
  const draft: ProxyCreate = { ...proxies.toUpdatePayload(proxy), ...changes };
  delete draft.plugins;
  return draft;
}

async function settle<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

const popups = vi.fn();

beforeEach(() => {
  resetGatewayMetadata();
  vi.stubGlobal("Request", BasedRequest);
  popups.mockReset();
  setApiErrorHandler(popups);
});
afterEach(() => {
  setApiErrorHandler(undefined);
  resetGatewayMetadata();
  vi.unstubAllGlobals();
});

describe("strongEtag", () => {
  it("accepts only a strong entity-tag", () => {
    expect(strongEtag('"r1"')).toBe('"r1"');
    expect(strongEtag(' "r1" ')).toBe('"r1"');
    expect(strongEtag('""')).toBe('""');
    expect(strongEtag('W/"r1"')).toBeNull();
    expect(strongEtag("r1")).toBeNull();
    expect(strongEtag('"r"1"')).toBeNull();
    expect(strongEtag('"r1", "r2"')).toBeNull();
    expect(strongEtag(null)).toBeNull();
  });
});

describe("guarded proxy saves on a gateway that honours If-Match", () => {
  it("sends the tag of the read it just verified", async () => {
    const seed = proxyFixture();
    const gateway = stubGateway(seed);

    await proxies.update(
      scope,
      "checkout",
      formDraft(seed, { backend_read_timeout_ms: 30_000 }),
      proxies.proxyWriteGuard(seed),
    );

    expect(gateway.wire).toEqual(["GET", 'PUT if-match "r0"']);
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
  });

  it("refuses a draft when another writer commits between the verification read and the PUT", async () => {
    // This is the window the verification read alone could not close: the
    // read matches the baseline, then administrator 1 commits, then
    // administrator 2's PUT arrives. The gateway refuses it atomically.
    const seed = proxyFixture();
    const gateway = stubGateway(seed, {
      interleave: (stored) => ({ ...stored, backend_host: "backend-b.internal" }),
    });

    const refused = await settle(
      proxies.update(
        scope,
        "checkout",
        formDraft(seed, { backend_read_timeout_ms: 30_000 }),
        proxies.proxyWriteGuard(seed),
      ),
    );

    if (!isStaleResourceError(refused)) throw new Error("expected a stale write");
    expect(refused.detail.original.backend_host).toBe("backend-a.internal");
    expect(refused.detail.current.backend_host).toBe("backend-b.internal");
    expect(refused.detail.proposed.backend_read_timeout_ms).toBe(30_000);
    expect(gateway.read().backend_host).toBe("backend-b.internal");
    expect(gateway.read().backend_read_timeout_ms).toBe(5_000);
    expect(gateway.wire).toEqual([
      "GET",
      'PUT if-match "r0"', // refused: r1 was committed in between
      "GET", // re-verified: the backend moved, so the draft stops here
    ]);
    // The 412 is resolved into the stale-write dialog, not a raw API error.
    expect(popups).not.toHaveBeenCalled();
  });

  it("re-sends against the fresh tag when only a field it does not replace moved", async () => {
    // A membership plan attached a plugin in the gap. The tag covers plugin
    // associations, so the PUT is refused; but a proxy save omits `plugins`
    // and cannot lose them, so the re-verified write goes through and the
    // association survives.
    const seed = proxyFixture();
    const gateway = stubGateway(seed, {
      interleave: (stored) => ({
        ...stored,
        plugins: [{ plugin_config_id: "rate-limit" }],
      }),
    });

    await proxies.update(
      scope,
      "checkout",
      formDraft(seed, { backend_read_timeout_ms: 30_000 }),
      proxies.proxyWriteGuard(seed),
    );

    expect(gateway.wire).toEqual([
      "GET",
      'PUT if-match "r0"',
      "GET",
      'PUT if-match "r1"',
    ]);
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
    expect(gateway.read().plugins).toEqual([{ plugin_config_id: "rate-limit" }]);
    expect(popups).not.toHaveBeenCalled();
  });

  it("never re-sends a plugin association list, even when the caller's body carries one", async () => {
    // A body built from `toUpdatePayload` still has `plugins`. Re-sent after a
    // 412 caused by a membership change, it would detach the plugin the other
    // writer just attached.
    const seed = proxyFixture();
    const gateway = stubGateway(seed, {
      interleave: (stored) => ({
        ...stored,
        plugins: [{ plugin_config_id: "rate-limit" }],
      }),
    });

    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_read_timeout_ms: 30_000 },
      proxies.proxyWriteGuard(seed),
    );

    expect(gateway.wire).toHaveLength(4);
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
    expect(gateway.read().plugins).toEqual([{ plugin_config_id: "rate-limit" }]);
  });

  it(`gives up after ${PRECONDITION_ATTEMPTS} refusals under continuous churn`, async () => {
    const seed = proxyFixture();
    let churn = 0;
    const gateway = stubGateway(seed, {
      interleaveTimes: Number.POSITIVE_INFINITY,
      interleave: (stored) => ({
        ...stored,
        plugins: [{ plugin_config_id: `churn-${(churn += 1)}` }],
      }),
    });

    const refused = await settle(
      proxies.update(
        scope,
        "checkout",
        formDraft(seed, { backend_read_timeout_ms: 30_000 }),
        proxies.proxyWriteGuard(seed),
      ),
    );

    expect(isStaleResourceError(refused)).toBe(true);
    expect(gateway.wire.filter((call) => call.startsWith("PUT"))).toHaveLength(
      PRECONDITION_ATTEMPTS,
    );
    expect(gateway.read().backend_read_timeout_ms).toBe(5_000);
  });

  it("still reports every other failure of a conditional PUT", async () => {
    const seed = proxyFixture();
    stubGateway(seed, { failConditionalWith: 400 });

    const failed = await settle(
      proxies.update(
        scope,
        "checkout",
        formDraft(seed, { backend_read_timeout_ms: 30_000 }),
        proxies.proxyWriteGuard(seed),
      ),
    );

    expect(isStaleResourceError(failed)).toBe(false);
    expect(popups).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it("sends no precondition on an unguarded write", async () => {
    // Membership plans run their own `updated_at` contract and pass `null`.
    const seed = proxyFixture();
    const gateway = stubGateway(seed);

    await proxies.update(scope, "checkout", proxies.toUpdatePayload(seed), null);

    expect(gateway.wire).toEqual(["PUT"]);
  });
});

describe("guarded saves on a gateway without a usable tag", () => {
  it("falls back to the verification read when the gateway issues no ETag", async () => {
    // The pinned pre-contract gateway, a database-less mode, or the
    // cached-config fallback. The guard still refuses a stale draft; it just
    // cannot close the gap between its read and the write.
    const seed = proxyFixture();
    const gateway = stubGateway(seed, { tags: "none" });

    await proxies.update(
      scope,
      "checkout",
      formDraft(seed, { backend_read_timeout_ms: 30_000 }),
      proxies.proxyWriteGuard(seed),
    );

    expect(gateway.wire).toEqual(["GET", "PUT"]);
  });

  it("never echoes a weak tag, which Edge's strong comparison could never match", async () => {
    const seed = proxyFixture();
    const gateway = stubGateway(seed, { tags: "weak" });

    await proxies.update(
      scope,
      "checkout",
      formDraft(seed, { backend_read_timeout_ms: 30_000 }),
      proxies.proxyWriteGuard(seed),
    );

    expect(gateway.wire).toEqual(["GET", "PUT"]);
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
  });
});

describe("guarded upstream saves on a gateway that honours If-Match", () => {
  const upstreamSeed: Upstream = {
    id: "payments",
    namespace: "tenant-a",
    name: "payments",
    algorithm: "round_robin",
    targets: [{ host: "one.internal", port: 443, weight: 1 }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("refuses a settings save when another writer commits in the gap", async () => {
    const gateway = stubGateway(upstreamSeed, {
      interleave: (stored) => ({ ...stored, algorithm: "least_connections" }),
    });

    const refused = await settle(
      upstreams.update(
        scope,
        "payments",
        { ...upstreams.toUpdatePayload(upstreamSeed), name: "renamed" },
        upstreams.upstreamWriteGuard(upstreamSeed),
      ),
    );

    expect(isStaleResourceError(refused)).toBe(true);
    expect(gateway.read().algorithm).toBe("least_connections");
    expect(gateway.read().name).toBe("payments");
    expect(gateway.wire).toEqual(["GET", 'PUT if-match "r0"', "GET"]);
  });

  it("refuses a target list when another writer changes targets in the gap", async () => {
    const gateway = stubGateway(upstreamSeed, {
      interleave: (stored) => ({
        ...stored,
        targets: [...upstreamSeed.targets, { host: "two.internal", port: 443, weight: 1 }],
      }),
    });

    const refused = await settle(
      upstreams.updateTargets(
        scope,
        "payments",
        [...upstreamSeed.targets, { host: "three.internal", port: 443, weight: 1 }],
        upstreams.targetsWriteGuard(upstreamSeed),
      ),
    );

    expect(isStaleResourceError(refused)).toBe(true);
    expect(gateway.read().targets.map((target) => target.host)).toEqual([
      "one.internal",
      "two.internal",
    ]);
  });

  it("makes an unguarded targets write conditional on the read its settings came from", async () => {
    const gateway = stubGateway(upstreamSeed, {
      interleave: (stored) => ({ ...stored, algorithm: "least_connections" }),
    });

    await upstreams.updateTargets(
      scope,
      "payments",
      [{ host: "two.internal", port: 443, weight: 1 }],
      null,
    );

    expect(gateway.wire).toEqual([
      "GET",
      'PUT if-match "r0"',
      "GET",
      'PUT if-match "r1"',
    ]);
    expect(gateway.read().algorithm).toBe("least_connections");
    expect(gateway.read().targets.map((target) => target.host)).toEqual(["two.internal"]);
  });

  it("keeps a settings change made in the gap and re-sends the targets over it", async () => {
    // The targets write takes every setting from the read it verified. A
    // settings change committed after that read would have been reverted by
    // the old read-then-write; now the gateway refuses the PUT, the re-read
    // finds the targets untouched, and the body is rebuilt from the new
    // settings.
    const gateway = stubGateway(upstreamSeed, {
      interleave: (stored) => ({ ...stored, algorithm: "least_connections" }),
    });

    await upstreams.updateTargets(
      scope,
      "payments",
      [{ host: "two.internal", port: 443, weight: 1 }],
      upstreams.targetsWriteGuard(upstreamSeed),
    );

    expect(gateway.wire).toEqual([
      "GET",
      'PUT if-match "r0"',
      "GET",
      'PUT if-match "r1"',
    ]);
    expect(gateway.read().algorithm).toBe("least_connections");
    expect(gateway.read().targets.map((target) => target.host)).toEqual(["two.internal"]);
  });
});
