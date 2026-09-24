import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminMetrics } from "@/api/types";
import {
  STORED_SAMPLE_MAX_AGE_MS,
  useGatewayRequestStats,
  type GatewayRequestStats,
} from "./useGatewayRequestStats";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "tenant-a", scope: { namespace: "tenant-a" } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse("2026-09-24T12:00:00Z");
let host: HTMLDivElement;
let root: Root;
let stats: GatewayRequestStats;

function gateway(totalRequests: number): AdminMetrics["gateway"] {
  return {
    uptime_seconds: 86_400 * 2,
    total_requests: totalRequests,
    status_codes_total: { "200": totalRequests },
  } as AdminMetrics["gateway"];
}

function Probe({ total, at }: { total: number; at: number }) {
  // A stable object per reading, as a query result is.
  const reading = useMemo(() => gateway(total), [total]);
  stats = useGatewayRequestStats(reading, at);
  return null;
}

function storeSample(timestamp: number, totalRequests: number) {
  localStorage.setItem(
    "ferrum:metricsRequestSample:tenant-a",
    JSON.stringify({
      timestamp,
      uptimeSeconds: 86_400,
      totalRequests,
      statusCodeTotals: { "200": totalRequests },
    }),
  );
}

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  localStorage.clear();
});

describe("gateway request rate", () => {
  it("does not report an average since a previous visit as the current rate", async () => {
    storeSample(now - 86_400_000, 0);
    await act(async () => root.render(<Probe total={864_000} at={now} />));
    expect(stats.requestsPerSecond).toBeUndefined();
  });

  it("bridges a recent remount with the stored sample", async () => {
    storeSample(now - 60_000, 0);
    await act(async () => root.render(<Probe total={6_000} at={now} />));
    expect(stats.requestsPerSecond).toBe(100);
  });

  it("keeps diffing in-memory samples at any refresh interval", async () => {
    await act(async () => root.render(<Probe total={0} at={now} />));
    const later = now + STORED_SAMPLE_MAX_AGE_MS * 2;
    await act(async () => root.render(<Probe total={18_000} at={later} />));
    expect(stats.requestsPerSecond).toBeCloseTo(18_000 / ((later - now) / 1000));
  });
});
