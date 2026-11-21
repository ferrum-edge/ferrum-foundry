import { describe, expect, it } from "vitest";
import { calculateRequestRates, type CounterSample } from "./requestRate";

function sample(
  timestampMs: number,
  uptimeSeconds: number,
  totalRequests = 50,
  requestedAt?: number,
): CounterSample {
  return {
    target: "target-a", mode: "dp", timestamp: timestampMs, requestedAt, uptimeSeconds,
    totalRequests, statusCodeTotals: { "200": totalRequests },
  };
}

describe("calculateRequestRates uptime tolerance", () => {
  it("gives a zero rate across a fresh snapshot and a near-expiry cache hit", () => {
    // Fresh at t=0 (uptime 100); at t=10.1 s Edge serves the snapshot it
    // cached at t=5.2 s (uptime 105).
    expect(calculateRequestRates(sample(10_100, 105), sample(0, 100))).toEqual({
      totalRequests: 50, requestsPerSecond: 0, statusCodesPerSecond: { "200": 0 },
    });
  });

  it("gives a zero rate when the first snapshot is the stale one, with whole-second rounding", () => {
    // t=0 serves a snapshot cached 5 s earlier (true uptime 95.99, reported
    // 95); t=10.1 s serves a fresh one (true 111.09, reported 111).
    expect(calculateRequestRates(sample(10_100, 111), sample(0, 95)).requestsPerSecond).toBe(0);
  });

  it("measures the uptime gap between requests, so a slow delivery cannot hide a zero", () => {
    // Fresh at t=0 (sent at 0, uptime 100); a cache hit sent at t=10.1 s that
    // Edge cached at t=5.2 s (uptime 105) only arrives at t=18.4 s.
    expect(calculateRequestRates(sample(18_400, 105, 50, 10_100), sample(200, 100, 50, 0))).toEqual({
      totalRequests: 50, requestsPerSecond: 0, statusCodesPerSecond: { "200": 0 },
    });
    // Same uptimes measured by arrival time would be refused.
    expect(calculateRequestRates(sample(18_400, 105), sample(0, 100)).requestsPerSecond).toBeUndefined();
  });

  it("still refuses a pair from different processes", () => {
    expect(calculateRequestRates(sample(60_000, 20), sample(0, 5)).requestsPerSecond).toBeUndefined();
    expect(calculateRequestRates(sample(60_000, 86_400), sample(0, 5)).requestsPerSecond).toBeUndefined();
  });
});
