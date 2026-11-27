import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChargebackSinkStatusResponse } from "@/api/ops";
import { ChargebackSinkPanel, chargebackSinkFindings } from "./OpsPanels";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

/** Shaped after `ChargebackSinkStatusResponse` in Edge v0.9.21's openapi.yaml. */
function liveStatus(): ChargebackSinkStatusResponse {
  return {
    enabled: true,
    instance_count: 1,
    snapshot_finalizations_pending: 0,
    snapshot_finalizations_pending_bytes: 0,
    snapshot_finalizations_oldest_age_secs: 0,
    snapshot_finalization_recovery_policy: "Restore spool writability; compact recoveries retry on reload and shutdown.",
    totals: {
      per_event: { received_total: 1200, persisted_total: 1180, dropped_total: 0, pending: 20 },
      queue: { outstanding: 20, depth: 3, capacity: 10000, full_drops_total: 0 },
      spool: { files: 0, bytes: 0, drops_total: 0, dead_letter_rows_total: 0, unbound_files: 0, available: true },
      export: { events_enqueued_total: 1200, events_exported_total: 1180, failures_total: 0 },
    },
    instances: [{
      plugin_config_id: "plg-sink",
      generation: 1,
      mode: "per_event",
      pricing_version: "v1",
      clickhouse: { endpoint: "https://clickhouse.internal:8443/redacted", database: "ferrum", table: "charges_raw" },
      batch: { size: 500, flush_interval_ms: 2000 },
      retry: { max_attempts: 5 },
      per_event: { received_total: 1200, persisted_total: 1180, dropped_total: 0, pending: 20 },
      queue: { depth: 3, capacity: 10000 },
      spool: { enabled: true, available: true },
      export: { events_exported_total: 1180, failures_total: 0, last_success_at: "2026-11-27T10:00:00Z", last_failure_at: null },
    }],
  };
}

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let failure: number | "network" | null;
let status: ChargebackSinkStatusResponse;
let requests: Request[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Request", BasedRequest);
  failure = null;
  status = liveStatus();
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    if (failure === "network") throw new TypeError("Failed to fetch");
    return Response.json(failure ? { error: "Unavailable" } : status, {
      status: typeof failure === "number" ? failure : 200,
    });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><ChargebackSinkPanel /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
}

describe("chargeback sink delivery status", () => {
  it("reads only GET /charges/sink/status with the bound namespace header", async () => {
    await mount();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/api/proxy/charges/sink/status");
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("ferrum");
    }
  });

  it("shows each live instance with its redacted endpoint, spool, and last export", async () => {
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("plg-sink");
    expect(text).toContain("per-event");
    expect(text).toContain("https://clickhouse.internal:8443/redacted");
    expect(text).toContain("ferrum.charges_raw");
    expect(text).toContain("available");
    expect(text).toContain("Succeeded");
    expect(text).toContain("3 / 10,000");
    expect(text).toContain("No export failure, drop, dead letter, or unbound spool record");
  });

  it("reports recorded loss and an unwritable spool as findings", async () => {
    status.totals.export.failures_total = 4;
    status.totals.per_event.dropped_total = 2;
    status.totals.spool.available = false;
    status.totals.spool.dead_letter_rows_total = 1;
    status.instances[0].spool.available = false;
    status.instances[0].export.last_failure_at = "2026-11-27T10:05:00Z";
    status.instances[0].export.last_failure_reason = "connection refused";
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("4 ClickHouse export failures");
    expect(text).toContain("2 charge rows dropped");
    expect(text).toContain("Spool storage is not writable");
    expect(text).toContain("1 rows dead-lettered");
    expect(text).toContain("unavailable");
    expect(text).toContain("connection refused");
    expect(text).not.toContain("No export failure");
  });

  it("states that no instance is live, keeping cumulative loss visible", async () => {
    status = { ...liveStatus(), enabled: false, instance_count: 0, instances: [] };
    status.totals.queue.full_drops_total = 7;
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("No api_chargeback_sink instance is live on this gateway");
    expect(text).toContain("7 events dropped on a full queue");
  });

  it("shows the recovery policy while snapshot finalizations are pending", () => {
    const pending = { ...liveStatus(), snapshot_finalizations_pending: 2 };
    expect(chargebackSinkFindings(pending)).toContain("2 snapshot finalizations pending recovery");
    expect(chargebackSinkFindings(liveStatus())).toEqual([]);
  });

  it.each([403, 500, "network"] as const)("reports %s as unavailable rather than as an idle sink", async (reason) => {
    failure = reason;
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("Sink delivery status unavailable");
    expect(text).not.toContain("No api_chargeback_sink instance is live");
  });
});
