import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminMetrics } from "@/api/types";
import MetricsPage from "@/routes/metrics/index";
import { ConnectionPoolPanel } from "./ConnectionPoolPanel";
import { CachePanel } from "./CachePanel";

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

function snapshot(mode: string): AdminMetrics {
  return {
    gateway: {
      mode, ferrum_version: "0.9.0", uptime_seconds: 10, total_requests: 0,
      requests_per_second: 0, status_codes_total: {}, status_codes_per_second: {},
      config_source_status: "online", proxy_count: 0, consumer_count: 0,
      upstream_count: 0, plugin_config_count: 0,
    },
    connection_pools: {},
    caches: {},
    circuit_breakers: [],
    health_check: { unhealthy_target_count: 0, unhealthy_targets: [] },
    load_balancers: { active_connections: [] },
    consumer_index: {
      total_consumers: 0, key_auth_credentials: 0, basic_auth_credentials: 0,
      mtls_credentials: 0, jwt_credentials: 0, hmac_credentials: 0, identity_credentials: 0,
    },
    rate_limiting: { tracked_key_count: 0 },
  };
}

describe("metrics mode shapes", () => {
  it.each(["cp", "node_agent"])("renders the full route for %s with empty pools and caches", (mode) => {
    const client = new QueryClient();
    try {
      client.setQueryData(["adminMetrics", "ferrum"], snapshot(mode));
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}><MetricsPage /></QueryClientProvider>,
      );
      expect(html).toContain("Metrics Dashboard");
      expect(html).toContain("Connection pool metrics are not reported");
      expect(html).toContain("Cache metrics are not reported");
      expect(html).not.toContain("HTTP Pools");
    } finally {
      client.clear();
    }
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
