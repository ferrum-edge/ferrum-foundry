import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminMetrics } from "@/api/types";
import { adminMetricsSnapshot } from "@/test/__tests__/adminMetricsFixtures";
import MetricsPage from "@/routes/metrics/index";
import { ConnectionPoolPanel } from "./ConnectionPoolPanel";
import { CachePanel } from "./CachePanel";
import { GatewayStats } from "./GatewayStats";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" }, selectedNamespace: "ferrum" }),
}));

const pools: AdminMetrics["connection_pools"] = {
  http: { total_pools: 2, max_idle_per_host: 8, idle_timeout_seconds: 60, entries_per_host: { "host.test": 3 } },
  grpc: { total_connections: 4 },
  http2: { total_connections: 5 },
  http3: { total_connections: 6 },
};
const caches: AdminMetrics["caches"] = {
  router: { prefix_cache_entries: 7, regex_cache_entries: 8, prefix_eviction_count: 1, regex_eviction_count: 2, max_cache_entries: 100 },
  dns: { cache_entries: 9 },
};

const snapshot = adminMetricsSnapshot;

const requestStats = { totalRequests: 0, requestsPerSecond: 0 };

function renderMetricsPage(mode: string): string {
  const client = new QueryClient();
  try {
    client.setQueryData(["adminMetrics", "ferrum"], snapshot(mode));
    return renderToStaticMarkup(
      <QueryClientProvider client={client}><MetricsPage /></QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const PROXY_RUNTIME_CARDS = [">Uptime<", ">Requests/sec<", ">Total Requests<", ">Proxies<", ">Consumers<", ">Upstreams<", ">Plugin Configs<"];
const PROXY_PANELS = [">Circuit Breakers<", ">Connection Pools<", ">Health Checks<", ">Load Balancers<", ">Caches<", ">Rate Limiting<", ">Consumer Index<"];

describe("metrics mode shapes", () => {
  it.each([
    ["cp", "Control plane", "Online", "Not reported by a control plane"],
    ["node_agent", "Node agent", "Not applicable", "Not reported by a node agent"],
  ])("shows %s mode, version and source but no placeholder runtime values", (mode, label, source, unavailable) => {
    const html = renderToStaticMarkup(<GatewayStats metrics={snapshot(mode).gateway} requestStats={requestStats} />);
    expect(html).toContain(`>${label}</p>`);
    expect(html).toContain(`gateway.mode: ${mode}`);
    expect(html).toContain(">0.9.20</p>");
    expect(html).toContain(`>${source}</p>`);
    expect(html).toContain(unavailable);
    expect(html).toContain("holds no proxy state");
    for (const card of PROXY_RUNTIME_CARDS) expect(html).not.toContain(card);
    expect(html).not.toContain(">0m</p>");
    expect(html).not.toContain(">0</p>");
    expect(html).not.toContain("Last update not reported");
  });

  it("warns on an offline control-plane config source", () => {
    const gateway = { ...snapshot("cp").gateway, config_source_status: "offline" as const };
    const html = renderToStaticMarkup(<GatewayStats metrics={gateway} requestStats={requestStats} />);
    expect(html).toContain("text-warning");
    expect(html).toContain(">Offline</p>");
  });

  it.each(["database", "file", "dp", "mesh", "constructor"])("keeps genuine measured zeros visible in %s mode", (mode) => {
    const html = renderToStaticMarkup(<GatewayStats metrics={snapshot(mode).gateway} requestStats={requestStats} />);
    for (const card of PROXY_RUNTIME_CARDS) expect(html).toContain(card);
    expect(html).toContain(">0m</p>");
    expect(html).toContain(">0</p>");
    expect(html).toContain(`gateway.mode: ${mode}`);
    expect(html).not.toContain("Not reported by");
    expect(html).not.toContain("holds no proxy state");
  });

  it.each(["cp", "node_agent"])("renders the full route for %s without placeholder proxy panels", (mode) => {
    const html = renderMetricsPage(mode);
    expect(html).toContain(">Metrics</h1>");
    expect(html).toContain("holds no proxy state");
    // Overload, host runtime and chargeback read their own endpoints.
    expect(html).toContain(">Overload Protection<");
    expect(html).toContain(">Host Runtime<");
    expect(html).toContain(">API Chargeback<");
    for (const panel of PROXY_PANELS) expect(html).not.toContain(panel);
    for (const card of PROXY_RUNTIME_CARDS) expect(html).not.toContain(card);
  });

  it.each(["database", "dp", "mesh"])("renders every proxy panel with measured zeros for %s", (mode) => {
    const html = renderMetricsPage(mode);
    for (const panel of PROXY_PANELS) expect(html).toContain(panel);
    expect(html).toContain(">Total consumers<");
    expect(html).toContain(">Tracked Keys<");
    expect(html).toContain("gRPC Connections");
    expect(html).not.toContain("holds no proxy state");
  });

  it("keeps empty facilities distinct from measured zero values", () => {
    expect(renderToStaticMarkup(<ConnectionPoolPanel pools={{}} />)).toContain("not reported");
    expect(renderToStaticMarkup(<CachePanel caches={{}} />)).toContain("not reported");
    const zero = renderToStaticMarkup(<ConnectionPoolPanel pools={{ grpc: { total_connections: 0 } }} />);
    expect(zero).toContain("gRPC Connections");
    expect(zero).toContain(">0</p>");
    expect(zero).toContain("Not reported");
  });

  it.each(["http", "grpc", "http2", "http3"] as const)("renders a missing %s pool independently", (protocol) => {
    const partial = { ...pools };
    delete partial[protocol];
    const html = renderToStaticMarkup(<ConnectionPoolPanel pools={partial} />);
    expect(html).toContain("Not reported");
    if (protocol !== "http") expect(html).toContain("host.test");
  });

  it.each(["router", "dns"] as const)("renders a missing %s cache independently", (cache) => {
    const partial = { ...caches };
    delete partial[cache];
    expect(renderToStaticMarkup(<CachePanel caches={partial} />)).toContain("Not reported");
  });

  it("preserves full database pool and cache values", () => {
    const poolHtml = renderToStaticMarkup(<ConnectionPoolPanel pools={pools} />);
    const cacheHtml = renderToStaticMarkup(<CachePanel caches={caches} />);
    expect(poolHtml).toContain("host.test");
    expect(poolHtml).toContain("60s");
    expect(poolHtml).not.toContain("Not reported");
    expect(cacheHtml).toContain("DNS Cache Entries");
    expect(cacheHtml).toContain(">100</p>");
    expect(cacheHtml).not.toContain("Not reported");
  });
});
