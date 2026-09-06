import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminMetrics } from "@/api/types";
import MetricsPage from "@/routes/metrics";
import { DEFAULT_METRICS_REFRESH_INTERVAL, getStoredMetricsRefreshInterval, METRICS_REFRESH_INTERVAL_KEY } from "@/utils/metricsRefresh";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" }, selectedNamespace: "ferrum" }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
const metrics: AdminMetrics = {
  gateway: {
    mode: "database", ferrum_version: "0.9.0", uptime_seconds: 10, total_requests: 0,
    requests_per_second: 0, status_codes_total: {}, status_codes_per_second: {},
    config_source_status: "online", proxy_count: 0, consumer_count: 0,
    upstream_count: 0, plugin_config_count: 0,
  },
  connection_pools: {}, caches: {}, circuit_breakers: [],
  health_check: { unhealthy_target_count: 0, unhealthy_targets: [] },
  load_balancers: { active_connections: [] },
  consumer_index: {
    total_consumers: 0, key_auth_credentials: 0, basic_auth_credentials: 0,
    mtls_credentials: 0, jwt_credentials: 0, hmac_credentials: 0, identity_credentials: 0,
  },
  rate_limiting: { tracked_key_count: 0 },
};
const paths = ["/admin/metrics", "/metrics", "/metrics/runtime", "/overload", "/charges"];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let counts: Record<string, number>;
let failPrometheus: boolean;
let holdPrometheus: boolean;
let releasePrometheus: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Request", BasedRequest);
  localStorage.clear();
  counts = {};
  failPrometheus = false;
  holdPrometheus = false;
  releasePrometheus = undefined;
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname.replace("/api/proxy", "");
    expect(request.headers.get("X-Ferrum-Namespace")).toBe("ferrum");
    counts[path] = (counts[path] ?? 0) + 1;
    if (path === "/admin/metrics") return Response.json(metrics);
    if (path === "/metrics/runtime") return Response.json({});
    if (path === "/overload") return Response.json({ level: "normal" });
    if (path === "/charges") return Response.json({ consumers: {} });
    expect(path).toBe("/metrics");
    if (failPrometheus) return new Response("Unavailable", { status: 503 });
    if (holdPrometheus) await new Promise<void>((resolve) => { releasePrometheus = resolve; });
    return new Response(`ferrum_requests_total{proxy_id="sample",method="GET",status_code="200"} ${counts[path]}\n`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  releasePrometheus?.();
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function mount(interval: number) {
  localStorage.setItem(METRICS_REFRESH_INTERVAL_KEY, String(interval));
  await act(async () => root.render(<QueryClientProvider client={client}><MetricsPage /></QueryClientProvider>));
  // Admin data mounts the operational panels in a subsequent React commit.
  await advance(100);
  await advance(100);
  for (const path of paths) expect(counts[path], path).toBe(1);
  expect(host.textContent).toContain("Requests by Route");
}
function refreshButton() {
  return [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh"))!;
}

describe("Metrics page refresh policy", () => {
  it.each([10000, 30000, 60000, 120000, 300000, 600000])("refreshes every participating panel at %i ms", async (interval) => {
    await mount(interval);
    await advance(interval + 200);
    for (const path of paths) expect(counts[path], path).toBe(2);
  });

  it("stops periodic reads in Manual and Refresh Now fetches every panel once", async () => {
    await mount(0);
    await advance(61000);
    for (const path of paths) expect(counts[path], path).toBe(1);
    await act(async () => refreshButton().click());
    await advance(100);
    for (const path of paths) expect(counts[path], path).toBe(2);
    await advance(61000);
    for (const path of paths) expect(counts[path], path).toBe(2);
  });

  it("keeps the failed section's timestamp while other samples advance", async () => {
    await mount(10000);
    const section = [...host.querySelectorAll("section")].find((entry) => entry.textContent?.includes("Per-Route Metrics"))!;
    const timestamp = section.querySelector("time")!.dateTime;
    const adminTimestamp = client.getQueryState(["adminMetrics", "ferrum"])!.dataUpdatedAt;
    failPrometheus = true;
    await advance(12000);
    expect(section.textContent).toContain("Per-route metrics unavailable");
    expect(section.querySelector("time")!.dateTime).toBe(timestamp);
    expect(client.getQueryState(["adminMetrics", "ferrum"])!.dataUpdatedAt).toBeGreaterThan(adminTimestamp);
    expect(host.textContent).toContain("Admin metrics updated");
    failPrometheus = false;
    await advance(10000);
    expect(section.textContent).not.toContain("Per-route metrics unavailable");
    expect(section.querySelector("time")!.dateTime).not.toBe(timestamp);
  });

  it("keeps Refresh Now busy until the slow section finishes without a duplicate read", async () => {
    await mount(0);
    holdPrometheus = true;
    await act(async () => refreshButton().click());
    await advance(100);
    expect(refreshButton().disabled).toBe(true);
    await act(async () => refreshButton().click());
    await advance(5000);
    expect(counts["/metrics"]).toBe(2);
    releasePrometheus!();
    await advance(100);
    expect(refreshButton().disabled).toBe(false);
  });

  it.each(["NaN", "-1", "1", "Infinity", "junk"])("rejects unsupported stored interval %s", (value) => {
    localStorage.setItem(METRICS_REFRESH_INTERVAL_KEY, value);
    expect(getStoredMetricsRefreshInterval()).toBe(DEFAULT_METRICS_REFRESH_INTERVAL);
  });
});
