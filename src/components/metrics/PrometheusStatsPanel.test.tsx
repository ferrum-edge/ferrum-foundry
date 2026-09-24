import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrometheusStatsPanel } from "./PrometheusStatsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function exposition(topBucketCount: number): string {
  return [
    'ferrum_requests_total{proxy_id="orders",method="GET",status_code="200"} 100',
    'ferrum_request_duration_ms_bucket{proxy_id="orders",le="100"} 50',
    `ferrum_request_duration_ms_bucket{proxy_id="orders",le="10000"} ${topBucketCount}`,
    'ferrum_request_duration_ms_bucket{proxy_id="orders",le="+Inf"} 100',
    'ferrum_request_duration_ms_sum{proxy_id="orders"} 900000',
    'ferrum_request_duration_ms_count{proxy_id="orders"} 100',
  ].join("\n");
}

describe("PrometheusStatsPanel latency percentiles", () => {
  it("reports a p99 above the largest bucket as a lower bound", async () => {
    await act(async () => root.render(<PrometheusStatsPanel text={exposition(95)} />));
    expect(host.textContent).toContain("> 10.00s");
  });

  it("reports a p99 inside the buckets as that bucket's bound", async () => {
    await act(async () => root.render(<PrometheusStatsPanel text={exposition(100)} />));
    expect(host.textContent).toContain("10.00s");
    expect(host.textContent).not.toContain(">");
  });
});
