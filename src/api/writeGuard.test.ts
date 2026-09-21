/* ------------------------------------------------------------------ */
/*  Cross-session lost-update regression (#381)                        */
/* ------------------------------------------------------------------ */

/**
 * Two administrators, both legitimately authorized for one namespace, edit the
 * same resource. The second one submits an older draft.
 *
 * `scripts/concurrent-edit-contract.mjs` runs the same sequence against the
 * pinned real gateway. This file is the deterministic version: it also asserts
 * the *unguarded* baseline — what Foundry did before this change and what the
 * gateway still does for any other admin-API client — so the regression fails
 * loudly if the guard is ever removed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isStaleResourceError } from "./conditionalWrite";
import { resetGatewayMetadata } from "./gatewayMetadata";
import * as proxies from "./proxies";
import * as upstreams from "./upstreams";
import type { Proxy, Upstream } from "./types";

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

/** A gateway that accepts every full-replacement PUT, exactly as Edge does. */
function stubGateway(seed: Proxy) {
  let stored = seed;
  let revision = 0;
  const wire: string[] = [];

  const fetcher = vi.fn(async (request: Request) => {
    wire.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === "PUT") {
      const body = (await request.json()) as Partial<Proxy>;
      revision += 1;
      stored = { ...stored, ...body, updated_at: `rev-${revision}` };
    }
    return Response.json(stored);
  });
  vi.stubGlobal("fetch", fetcher);
  return { wire, read: () => stored };
}

describe("cross-session proxy saves", () => {
  beforeEach(() => {
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("refuses an older draft instead of reverting an accepted change", async () => {
    const seed = proxyFixture();
    const gateway = stubGateway(seed);

    // Both editors opened against the same content.
    const editorOne = proxies.proxyWriteGuard(seed);
    const editorTwo = proxies.proxyWriteGuard(seed);

    // Administrator 1 repoints the backend and the gateway accepts it.
    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_host: "backend-b.internal" },
      editorOne,
    );
    expect(gateway.read().backend_host).toBe("backend-b.internal");

    // Administrator 2 submits their older draft, changing only the timeout.
    const staleDraft = {
      ...proxies.toUpdatePayload(seed),
      backend_read_timeout_ms: 30_000,
    };
    const refused = await proxies
      .update(scope, "checkout", staleDraft, editorTwo)
      .then(() => null, (error: unknown) => error);

    expect(isStaleResourceError(refused)).toBe(true);
    // The accepted change survived, and the stale body never reached the wire.
    expect(gateway.read().backend_host).toBe("backend-b.internal");
    expect(gateway.read().backend_read_timeout_ms).toBe(5_000);
    expect(gateway.wire).toEqual([
      "GET /api/proxy/proxies/checkout", // administrator 1 verifies …
      "PUT /api/proxy/proxies/checkout", // … and writes
      "GET /api/proxy/proxies/checkout", // administrator 2 verifies and stops here
    ]);
  });

  it("carries the three sides of the conflict for the operator to compare", async () => {
    const seed = proxyFixture();
    stubGateway(seed);
    const editorTwo = proxies.proxyWriteGuard(seed);

    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_host: "backend-b.internal" },
      proxies.proxyWriteGuard(seed),
    );

    const refused = await proxies
      .update(
        scope,
        "checkout",
        { ...proxies.toUpdatePayload(seed), backend_read_timeout_ms: 30_000 },
        editorTwo,
      )
      .then(() => null, (error: unknown) => error);

    if (!isStaleResourceError(refused)) throw new Error("expected a stale write");
    expect(refused.detail).toMatchObject({
      resource: "proxy",
      id: "checkout",
      namespace: "tenant-a",
    });
    expect(refused.detail.original.backend_host).toBe("backend-a.internal");
    expect(refused.detail.current.backend_host).toBe("backend-b.internal");
    expect(refused.detail.proposed.backend_read_timeout_ms).toBe(30_000);
    // Server-managed fields are not part of what an operator is asked to resolve.
    expect(refused.detail.current).not.toHaveProperty("updated_at");
  });

  it("documents the unguarded baseline: the gateway reverts the newer value", async () => {
    // This is what any other admin-API client still does, and what Foundry did
    // before the guard. It is asserted so the regression above cannot quietly
    // become vacuous.
    const seed = proxyFixture();
    const gateway = stubGateway(seed);

    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_host: "backend-b.internal" },
      null,
    );
    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_read_timeout_ms: 30_000 },
      null,
    );

    expect(gateway.read().backend_host).toBe("backend-a.internal");
    expect(gateway.wire.filter((call) => call.startsWith("PUT"))).toHaveLength(2);
  });

  it("lets a re-seeded editor save once the operator has seen current content", async () => {
    const seed = proxyFixture();
    const gateway = stubGateway(seed);

    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_host: "backend-b.internal" },
      proxies.proxyWriteGuard(seed),
    );

    // The operator reloaded: the editor now holds the gateway's current content.
    const reloaded = await proxies.get(scope, "checkout");
    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(reloaded), backend_read_timeout_ms: 30_000 },
      proxies.proxyWriteGuard(reloaded),
    );

    expect(gateway.read().backend_host).toBe("backend-b.internal");
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
  });

  it("is not tripped by a plugin association written from the plugin pages", async () => {
    const seed = proxyFixture();
    const gateway = stubGateway(seed);
    const editor = proxies.proxyWriteGuard(seed);

    // A membership plan attaches a plugin. A proxy save omits `plugins`, so it
    // cannot lose that association and must not be refused because of it.
    await proxies.update(
      scope,
      "checkout",
      {
        ...proxies.toUpdatePayload(seed),
        plugins: [{ plugin_config_id: "rate-limit" }],
      },
      null,
    );

    await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(seed), backend_read_timeout_ms: 30_000 },
      editor,
    );
    expect(gateway.read().backend_read_timeout_ms).toBe(30_000);
  });
});

describe("cross-session upstream target edits", () => {
  const upstreamSeed: Upstream = {
    id: "payments",
    namespace: "tenant-a",
    algorithm: "round_robin",
    targets: [{ host: "one.internal", port: 443, weight: 1 }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  function stubUpstreamGateway(seed: Upstream) {
    let stored = seed;
    let revision = 0;
    const wire: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        wire.push(request.method);
        if (request.method === "PUT") {
          const body = (await request.json()) as Partial<Upstream>;
          revision += 1;
          stored = { ...stored, ...body, updated_at: `rev-${revision}` };
        }
        return Response.json(stored);
      }),
    );
    return { wire, read: () => stored };
  }

  beforeEach(() => {
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("refuses a target list computed from a stale view", async () => {
    const gateway = stubUpstreamGateway(upstreamSeed);
    const editorTwo = upstreams.targetsWriteGuard(upstreamSeed);

    // Administrator 1 adds a target.
    await upstreams.updateTargets(
      scope,
      "payments",
      [...upstreamSeed.targets, { host: "two.internal", port: 443, weight: 1 }],
      upstreams.targetsWriteGuard(upstreamSeed),
    );
    expect(gateway.read().targets).toHaveLength(2);

    // Administrator 2 adds a different target to the list they were shown.
    const refused = await upstreams
      .updateTargets(
        scope,
        "payments",
        [...upstreamSeed.targets, { host: "three.internal", port: 443, weight: 1 }],
        editorTwo,
      )
      .then(() => null, (error: unknown) => error);

    expect(isStaleResourceError(refused)).toBe(true);
    expect(gateway.read().targets.map((target) => target.host)).toEqual([
      "one.internal",
      "two.internal",
    ]);
  });

  it("still composes with a settings save from this same client", async () => {
    // #235/#254: the targets write reads the current settings and preserves
    // them. Scoping its guard to `targets` keeps that supported composition.
    const gateway = stubUpstreamGateway(upstreamSeed);

    await upstreams.update(
      scope,
      "payments",
      {
        ...upstreams.toUpdatePayload(upstreamSeed),
        health_checks: { active: { probe_type: "http", http_path: "/ready", interval_seconds: 5 } },
      },
      upstreams.upstreamWriteGuard(upstreamSeed),
    );

    await upstreams.updateTargets(
      scope,
      "payments",
      [{ host: "two.internal", port: 443, weight: 1 }],
      upstreams.targetsWriteGuard(upstreamSeed),
    );

    expect(gateway.read().health_checks?.active?.http_path).toBe("/ready");
    expect(gateway.read().targets.map((target) => target.host)).toEqual(["two.internal"]);
  });
});
