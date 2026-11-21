import { act, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeGatewayTarget, resetGatewayTarget } from "@/api/gatewayTarget";
import type { AdminMetrics } from "@/api/types";
import { GatewayTargetGate } from "@/components/auth/GatewayTargetGate";
import { createHarness } from "@/test/__tests__/harness";
import {
  STORED_SAMPLE_MAX_AGE_MS,
  STORED_SAMPLE_VERSION,
  resetPlaceholderObservations,
  useGatewayRequestStats,
  type GatewayRequestStats,
} from "./useGatewayRequestStats";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "tenant-a", scope: { namespace: "tenant-a" } }),
}));

const STORAGE_KEY = "ferrum:metricsRequestSample:tenant-a";
const now = Date.parse("2026-09-24T12:00:00Z");
let ui: ReturnType<typeof createHarness>;
let stats: GatewayRequestStats | undefined;
/** Every render's result, so a test can check the first commit of a reading. */
let renders: { mode: string; total: number; stats: GatewayRequestStats }[] = [];

function gateway(totalRequests: number, uptimeSeconds: number, mode: string): AdminMetrics["gateway"] {
  return {
    mode,
    uptime_seconds: uptimeSeconds,
    total_requests: totalRequests,
    status_codes_total: { "200": totalRequests },
  } as unknown as AdminMetrics["gateway"];
}

function Probe({
  total,
  at,
  uptime = 86_400 * 2,
  mode = "database",
}: {
  total: number;
  at: number;
  uptime?: number;
  mode?: string;
}) {
  // A stable object per reading, as a query result is.
  const reading = useMemo(() => gateway(total, uptime, mode), [total, uptime, mode]);
  stats = useGatewayRequestStats(reading, at);
  renders.push({ mode, total, stats });
  return null;
}

function storeSample(
  timestamp: number,
  totalRequests: number,
  target?: string,
  fields: Record<string, unknown> = { version: STORED_SAMPLE_VERSION, mode: "database" },
) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...fields,
      ...(target === undefined ? {} : { target }),
      timestamp,
      uptimeSeconds: 86_400,
      totalRequests,
      statusCodeTotals: { "200": totalRequests },
    }),
  );
}

/** A fresh page load bound to `target`, with browser storage retained. */
async function openPage(target: string) {
  await ui.dispose();
  resetGatewayTarget();
  observeGatewayTarget(target);
  stats = undefined;
  ui = createHarness();
}

async function show(reading: { total: number; at: number; uptime?: number; mode?: string }) {
  await ui.render(
    <GatewayTargetGate onReload={() => undefined}>
      <Probe {...reading} />
    </GatewayTargetGate>,
  );
}

/** What the first render holding this reading returned. */
function firstRender(mode: string, total: number): GatewayRequestStats | undefined {
  return renders.find((r) => r.mode === mode && r.total === total)?.stats;
}

beforeEach(() => {
  renders = [];
  resetPlaceholderObservations();
  resetGatewayTarget();
  observeGatewayTarget("target-a");
  stats = undefined;
  ui = createHarness();
});
afterEach(async () => {
  await ui.dispose();
  resetGatewayTarget();
  localStorage.clear();
});

describe("gateway request rate", () => {
  it("does not report an average since a previous visit as the current rate", async () => {
    storeSample(now - 86_400_000, 0, "target-a");
    await show({ total: 864_000, at: now });
    expect(stats?.requestsPerSecond).toBeUndefined();
  });

  it("bridges a recent remount with the stored sample", async () => {
    storeSample(now - 60_000, 0, "target-a");
    await show({ total: 6_000, at: now });
    expect(stats?.requestsPerSecond).toBe(100);
  });

  it("keeps diffing in-memory samples at any refresh interval", async () => {
    await show({ total: 0, at: now });
    const later = now + STORED_SAMPLE_MAX_AGE_MS * 2;
    await show({ total: 18_000, at: later });
    expect(stats?.requestsPerSecond).toBeCloseTo(18_000 / ((later - now) / 1000));
  });

  it("ignores a stored sample that names no gateway target", async () => {
    storeSample(now - 60_000, 0);
    await show({ total: 6_000, at: now });
    expect(stats?.requestsPerSecond).toBeUndefined();
    expect(stats?.statusCodesPerSecond).toBeUndefined();
  });

  it("neither diffs nor stores a reading before a gateway target is bound", async () => {
    resetGatewayTarget();
    storeSample(now - 60_000, 0, "target-a");
    await show({ total: 6_000, at: now });
    expect(stats).toEqual({ totalRequests: 6_000 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ totalRequests: 0 });
  });

  it("does not diff a new gateway's first reading against the replaced gateway's", async () => {
    await show({ total: 100, at: now });

    // The BFF is re-pointed: the workspace retires and the page reloads.
    await act(async () => observeGatewayTarget("target-b"));
    expect(ui.host.textContent).toContain("Gateway target changed");
    await openPage("target-b");

    // Gateway B has run longer and served more than A had.
    await show({ total: 36_100, at: now + 60_000, uptime: 86_400 * 3 });
    expect(stats?.totalRequests).toBe(36_100);
    expect(stats?.requestsPerSecond).toBeUndefined();
    expect(stats?.statusCodesPerSecond).toBeUndefined();

    // Two readings from B are comparable.
    await show({ total: 37_300, at: now + 120_000, uptime: 86_400 * 3 + 60 });
    expect(stats?.requestsPerSecond).toBe(20);
  });

  it("does not diff against a pre-switch sample after switching back", async () => {
    await show({ total: 100, at: now });

    await act(async () => observeGatewayTarget("target-b"));
    await openPage("target-b");
    // B's counters are lower than A's, so only the target tells them apart.
    await show({ total: 50, at: now + 30_000, uptime: 86_400 });

    await act(async () => observeGatewayTarget("target-a"));
    await openPage("target-a");
    await show({ total: 1_300, at: now + 60_000 });
    expect(stats?.requestsPerSecond).toBeUndefined();
    expect(stats?.statusCodesPerSecond).toBeUndefined();
  });

  it("still bridges a reload that binds the same gateway target", async () => {
    await show({ total: 100, at: now });
    await openPage("target-a");
    await show({ total: 1_300, at: now + 60_000 });
    expect(stats?.requestsPerSecond).toBe(20);
    expect(stats?.statusCodesPerSecond).toEqual({ "200": 20 });
  });
  it.each(["cp", "node_agent"])("neither diffs nor stores %s placeholder zeros", async (mode) => {
    await show({ total: 0, at: now, uptime: 0, mode });
    expect(stats).toEqual({ totalRequests: 0 });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await show({ total: 0, at: now + 30_000, uptime: 0, mode });
    expect(stats).toEqual({ totalRequests: 0 });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("leaves another target's stored baseline intact when a cached placeholder renders", async () => {
    storeSample(now - 30_000, 700, "target-b");
    const stored = localStorage.getItem(STORAGE_KEY);
    await show({ total: 0, at: now, uptime: 0, mode: "cp" });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);

    // Target B's tab still bridges from its own baseline.
    await openPage("target-b");
    await show({ total: 1_000, at: now });
    expect(stats?.requestsPerSecond).toBe(10);
  });

  it("leaves the same target's stored baseline intact when a placeholder renders", async () => {
    await show({ total: 100, at: now });
    const stored = localStorage.getItem(STORAGE_KEY);
    await show({ total: 0, at: now + 30_000, uptime: 0, mode: "cp" });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);
  });

  it("starts collecting afresh when a control plane is replaced by a data plane at the same target", async () => {
    await show({ total: 0, at: now, uptime: 0, mode: "cp" });

    // A data plane answers at the same admin URL, so the target is unchanged.
    await show({ total: 600, at: now + 60_000, uptime: 5, mode: "dp" });
    // Its first commit, before the effect samples it, already shows its own
    // total and no rate.
    expect(firstRender("dp", 600)).toEqual({ totalRequests: 600 });
    expect(stats?.totalRequests).toBe(600);
    expect(stats?.requestsPerSecond).toBeUndefined();
    expect(stats?.statusCodesPerSecond).toBeUndefined();

    await show({ total: 1_200, at: now + 90_000, uptime: 35, mode: "dp" });
    expect(stats?.requestsPerSecond).toBe(20);
    expect(stats?.statusCodesPerSecond).toEqual({ "200": 20 });

    // And across a remount, from the stored data-plane sample.
    await openPage("target-a");
    await show({ total: 1_800, at: now + 120_000, uptime: 65, mode: "dp" });
    expect(stats?.requestsPerSecond).toBe(20);
  });

  it("does not diff readings from different modes", async () => {
    await show({ total: 100, at: now, mode: "database" });
    await show({ total: 1_300, at: now + 60_000, mode: "database" });
    expect(stats?.requestsPerSecond).toBe(20);

    // The first commit holding a dp reading does not show the database rate.
    await show({ total: 1_900, at: now + 90_000, mode: "dp" });
    expect(firstRender("dp", 1_900)).toEqual({ totalRequests: 1_900 });
    expect(stats).toEqual({ totalRequests: 1_900 });
  });

  it("shows a placeholder reading's total as zero from its first commit", async () => {
    await show({ total: 100, at: now });
    await show({ total: 1_300, at: now + 60_000 });
    await show({ total: 0, at: now + 90_000, uptime: 0, mode: "node_agent" });
    expect(firstRender("node_agent", 0)).toEqual({ totalRequests: 0 });
  });

  it("ignores a stored sample written before samples carried their mode", async () => {
    // A pre-#720 sample may be a control plane's placeholder zeros.
    storeSample(now - 60_000, 0, "target-a", {});
    await show({ total: 6_000, at: now, mode: "dp" });
    expect(stats?.requestsPerSecond).toBeUndefined();
  });

  it.each([
    ["a placeholder mode", { version: STORED_SAMPLE_VERSION, mode: "cp" }],
    ["another mode", { version: STORED_SAMPLE_VERSION, mode: "file" }],
    ["another version", { version: 1, mode: "database" }],
  ])("ignores a stored sample from %s", async (_label, fields) => {
    storeSample(now - 60_000, 0, "target-a", fields);
    await show({ total: 6_000, at: now });
    expect(stats?.requestsPerSecond).toBeUndefined();
  });
  it.each(["cp", "node_agent"])(
    "does not bridge a replacement data plane from a sample stored before a %s placeholder",
    async (mode) => {
      await show({ total: 100, at: now, uptime: 5, mode: "dp" });
      await show({ total: 0, at: now + 30_000, uptime: 0, mode });
      // A different data plane process answers at the same admin URL, with a
      // higher uptime and counter than the stored sample.
      await show({ total: 1_300, at: now + 60_000, uptime: 20, mode: "dp" });
      expect(stats).toEqual({ totalRequests: 1_300 });

      await show({ total: 1_900, at: now + 90_000, uptime: 50, mode: "dp" });
      expect(stats?.requestsPerSecond).toBe(20);
      expect(stats?.statusCodesPerSecond).toEqual({ "200": 20 });
    },
  );

  it.each(["cp", "node_agent"])("refuses the pre-%s sample after a remount too", async (mode) => {
    await show({ total: 100, at: now, uptime: 5, mode: "dp" });
    await show({ total: 0, at: now + 30_000, uptime: 0, mode });
    await openPage("target-a");
    await show({ total: 1_300, at: now + 60_000, uptime: 20, mode: "dp" });
    expect(stats).toEqual({ totalRequests: 1_300 });
  });

  it("bridges a remount from a baseline sampled after the placeholder", async () => {
    await show({ total: 0, at: now, uptime: 0, mode: "cp" });
    await show({ total: 100, at: now + 30_000, uptime: 5, mode: "dp" });
    await openPage("target-a");
    await show({ total: 700, at: now + 60_000, uptime: 35, mode: "dp" });
    expect(stats?.requestsPerSecond).toBe(20);
  });

  it("does not let a placeholder at one target refuse another target's baseline", async () => {
    await show({ total: 0, at: now, uptime: 0, mode: "cp" });
    storeSample(now - 30_000, 700, "target-b");
    await openPage("target-b");
    await show({ total: 1_000, at: now });
    expect(stats?.requestsPerSecond).toBe(10);
  });
});
