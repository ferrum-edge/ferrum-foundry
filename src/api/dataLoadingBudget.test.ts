/* ------------------------------------------------------------------ */
/*  Navigation request budgets at a stress collection size (#382)      */
/* ------------------------------------------------------------------ */

/**
 * A repeatable fixture at two sizes — the initially supported envelope and the
 * 50,000-record stress target — driving the shipped API modules through a
 * stubbed gateway that serves only `offset`/`limit`, exactly like the admin
 * API does.
 *
 * What this measures is **request counts and response bytes**. That is the
 * thing a budget can fail closed on, and it is the thing the issue's
 * acceptance criteria name. It deliberately does not claim a latency number:
 * that depends on hardware, network, and rendering, none of which this
 * process has. `docs/data-loading.md` records the assumptions and the
 * measured numbers this test enforces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as proxies from "./proxies";
import * as upstreams from "./upstreams";
import * as plugins from "./plugins";
import { ALL_PAGE_SIZE, SUMMARY_SCAN_BUDGET } from "./pagination";
import { resetGatewayMetadata } from "./gatewayMetadata";
import type { PluginConfig, Proxy, Upstream } from "./types";

const UI_PAGE_SIZE = 20;
const SUPPORTED_SIZE = 500;
const STRESS_SIZE = 50_000;

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

function proxyAt(index: number): Proxy {
  return {
    id: `proxy-${index}`,
    namespace: "budget",
    name: `proxy-${index}`,
    hosts: [],
    listen_path: `/p/${index}`,
    backend_scheme: "https",
    backend_host: "backend.internal",
    backend_port: 8443,
    upstream_id: `upstream-${index}`,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 2000,
    backend_read_timeout_ms: 5000,
    backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 30,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function upstreamAt(index: number): Upstream {
  return {
    id: `upstream-${index}`,
    namespace: "budget",
    name: `upstream ${index}`,
    algorithm: "round_robin",
    targets: [{ host: "backend.internal", port: 8443, weight: 1 }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function pluginAt(index: number): PluginConfig {
  return {
    id: `plugin-${index}`,
    namespace: "budget",
    plugin_name: "rate_limiting",
    scope: "proxy",
    proxy_id: `proxy-${index}`,
    config: { limit: 100, window_seconds: 60 },
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function pageOf<T>(build: (index: number) => T, total: number, offset: number, limit: number) {
  const end = Math.min(offset + limit, total);
  return {
    data: Array.from({ length: Math.max(0, end - offset) }, (_, i) => build(offset + i)),
    pagination: { offset, limit, total },
  };
}

interface Budget {
  requests: number;
  responseBytes: number;
}

let log: { path: string; bytes: number }[] = [];

function installGateway(size: number) {
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? String(UI_PAGE_SIZE));

      let body: unknown;
      if (url.pathname === "/api/proxy/proxies") body = pageOf(proxyAt, size, offset, limit);
      else if (url.pathname === "/api/proxy/upstreams") body = pageOf(upstreamAt, size, offset, limit);
      else if (url.pathname === "/api/proxy/plugins/config") body = pageOf(pluginAt, size, offset, limit);
      else if (url.pathname.startsWith("/api/proxy/upstreams/")) {
        body = upstreamAt(Number(url.pathname.split("/").pop()!.replace("upstream-", "")));
      } else if (url.pathname.startsWith("/api/proxy/proxies/")) {
        body = proxyAt(Number(url.pathname.split("/").pop()!.replace("proxy-", "")));
      } else {
        throw new Error(`unexpected request: ${url.pathname}`);
      }

      const text = JSON.stringify(body);
      log.push({ path: url.pathname, bytes: text.length });
      return new Response(text, { headers: { "content-type": "application/json" } });
    }),
  );
}

async function measure(run: () => Promise<unknown>): Promise<Budget> {
  const before = log.length;
  await run();
  const slice = log.slice(before);
  return {
    requests: slice.length,
    responseBytes: slice.reduce((total, entry) => total + entry.bytes, 0),
  };
}

const scope = { namespace: "budget" };

/** What the proxy list page asks for when it shows the rows at `offset`. */
async function openProxyList(offset = 0): Promise<void> {
  const page = await proxies.list(scope, { offset, limit: UI_PAGE_SIZE });
  const catalog = await upstreams.list(scope, { offset: 0, limit: ALL_PAGE_SIZE });
  if (catalog.pagination.total <= catalog.data.length) return;

  const named = new Set(catalog.data.map((upstream) => upstream.id));
  const referenced = [
    ...new Set(page.data.map((proxy) => proxy.upstream_id).filter((id): id is string => Boolean(id))),
  ].filter((id) => !named.has(id));
  await Promise.all(referenced.map((id) => upstreams.getReference(scope, id)));
}

describe("navigation request budgets", () => {
  beforeEach(() => {
    log = [];
    resetGatewayMetadata();
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it(`stays bounded at the initially supported size (${SUPPORTED_SIZE} records)`, async () => {
    installGateway(SUPPORTED_SIZE);

    // The whole catalog fits in one page, so reference resolution is free.
    const list = await measure(openProxyList);
    expect(list.requests).toBe(2);

    const detail = await measure(() => proxies.get(scope, "proxy-0"));
    expect(detail.requests).toBe(1);

    const summary = await measure(() => plugins.listBoundedConfigs(scope));
    expect(summary.requests).toBe(Math.ceil(SUPPORTED_SIZE / ALL_PAGE_SIZE));
  });

  it(`stays bounded at the ${STRESS_SIZE.toLocaleString("en-US")}-record stress size`, async () => {
    installGateway(STRESS_SIZE);

    // Best case: the rows on screen reference upstreams the catalog page
    // already named, so nothing further is requested.
    const firstPage = await measure(() => openProxyList(0));
    expect(firstPage.requests).toBe(2);

    // Worst case: every visible row references an upstream outside the catalog
    // page, so each one costs a read. That is the bound — one per visible row,
    // never a page of a collection the screen will not show.
    const deepPage = await measure(() => openProxyList(40_000));
    expect(deepPage.requests).toBe(2 + UI_PAGE_SIZE);
    // The traversal it replaced: 200 sequential pages of upstreams alone.
    expect(deepPage.requests).toBeLessThan(Math.ceil(STRESS_SIZE / ALL_PAGE_SIZE));
    const list = deepPage;

    const detail = await measure(() => proxies.get(scope, "proxy-0"));
    expect(detail.requests).toBe(1);

    const summary = await measure(() => plugins.listBoundedConfigs(scope));
    expect(summary.requests).toBeLessThanOrEqual(
      Math.ceil(SUMMARY_SCAN_BUDGET / ALL_PAGE_SIZE),
    );

    // Response volume, not just request count: a page of rows plus one catalog
    // page is a small fraction of the collection it used to download.
    const wholeCollection = await measure(() => upstreams.listAll(scope));
    expect(list.responseBytes * 20).toBeLessThan(wholeCollection.responseBytes);

    // The numbers this asserts are tabulated in `docs/data-loading.md`.
  }, 60_000);

  it("reports an over-budget summary as incomplete rather than as a count", async () => {
    installGateway(STRESS_SIZE);
    const summary = await plugins.listBoundedConfigs(scope);

    expect(summary.complete).toBe(false);
    expect(summary.total).toBe(STRESS_SIZE);
    expect(summary.items.length).toBeLessThan(STRESS_SIZE);
  }, 30_000);

  it("still traverses completely when the answer must be complete", async () => {
    installGateway(SUPPORTED_SIZE);
    const everything = await plugins.listAllConfigs(scope);
    expect(everything).toHaveLength(SUPPORTED_SIZE);
  });
});
