/* ------------------------------------------------------------------ */
/*  One proxy's plugin configurations (ferrum-edge#5726, Edge v0.9.7)  */
/* ------------------------------------------------------------------ */

/**
 * `GET /plugins/config?proxy_id=` paginates the filtered set, so listing what
 * targets one proxy costs that proxy's configurations, never the namespace.
 * A gateway that ignored the parameter would answer with the namespace, so a
 * record for another proxy must fail the read rather than be shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as plugins from "./plugins";
import { ALL_PAGE_SIZE } from "./pagination";
import { resetGatewayMetadata } from "./gatewayMetadata";
import type { PluginConfig } from "./types";

const NAMESPACE_SIZE = 50_000;
/** Every hundredth configuration targets `proxy-7`, spread across the namespace. */
const TARGETING = NAMESPACE_SIZE / 100;

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

function pluginAt(index: number): PluginConfig {
  return {
    id: `plugin-${index}`,
    namespace: "tenant-a",
    plugin_name: "rate_limiting",
    scope: "proxy",
    proxy_id: index % 100 === 7 ? "proxy-7" : `proxy-${index}`,
    config: {},
    enabled: index % 200 === 7,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

let requests: URL[] = [];
let namespaces: (string | null)[] = [];

function installGateway({ honoursFilter }: { honoursFilter: boolean }) {
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      requests.push(url);
      namespaces.push(input.headers.get("x-ferrum-namespace"));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const proxyId = url.searchParams.get("proxy_id");
      const all = Array.from({ length: NAMESPACE_SIZE }, (_, index) => index);
      const matching = honoursFilter && proxyId !== null
        ? all.filter((index) => pluginAt(index).proxy_id === proxyId)
        : all;
      return Response.json({
        data: matching.slice(offset, offset + limit).map(pluginAt),
        pagination: { offset, limit, total: matching.length },
      });
    }),
  );
}

const scope = { namespace: "tenant-a" };

describe("listConfigsForProxy", () => {
  beforeEach(() => {
    requests = [];
    namespaces = [];
    resetGatewayMetadata();
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("walks the filtered set, disabled and enabled alike, not the namespace", async () => {
    installGateway({ honoursFilter: true });

    const targeting = await plugins.listConfigsForProxy(scope, "proxy-7");

    expect(targeting).toHaveLength(TARGETING);
    expect(targeting.every((config) => config.proxy_id === "proxy-7")).toBe(true);
    expect(targeting.some((config) => !config.enabled)).toBe(true);
    // 500 matching records: two pages, where the namespace would be 200.
    expect(requests).toHaveLength(Math.ceil(TARGETING / ALL_PAGE_SIZE));
    for (const url of requests) {
      expect(url.pathname).toBe("/api/proxy/plugins/config");
      expect(url.searchParams.get("proxy_id")).toBe("proxy-7");
    }
    expect(requests.map((url) => url.searchParams.get("offset"))).toEqual(["0", "250"]);
    expect(new Set(namespaces)).toEqual(new Set(["tenant-a"]));
  });

  it("answers an id no configuration targets with an empty list in one request", async () => {
    installGateway({ honoursFilter: true });

    await expect(plugins.listConfigsForProxy(scope, "proxy-unknown")).resolves.toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("refuses a response the filter did not narrow instead of traversing on", async () => {
    installGateway({ honoursFilter: false });

    const read = plugins.listConfigsForProxy(scope, "proxy-7");
    await expect(read).rejects.toBeInstanceOf(plugins.ProxyFilterNotAppliedError);
    await expect(read).rejects.toThrow(/Ferrum Edge v0\.9\.7/);
    // The first page gave it away; the remaining 199 were never requested.
    expect(requests).toHaveLength(1);
  });

  it("sends no proxy_id on the unfiltered listing", async () => {
    installGateway({ honoursFilter: true });

    await plugins.listConfigs(scope, { offset: 0, limit: 20 });
    expect(requests[0]!.searchParams.has("proxy_id")).toBe(false);
  });
});
