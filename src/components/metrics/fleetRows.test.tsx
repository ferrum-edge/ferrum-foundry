import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminMetricsUnhealthyTarget } from "@/api/types";
import { CircuitBreakerPanel } from "./CircuitBreakerPanel";
import { HealthCheckPanel, unhealthyTargetKey } from "./HealthCheckPanel";
import { LoadBalancerPanel } from "./LoadBalancerPanel";

// The admin metrics payload is fleet-wide, so a row is labelled with its
// namespace whenever that is not the selected one, whatever the names are.
describe("fleet-wide metrics rows", () => {
  it("labels load balancer rows outside the selected namespace", () => {
    const html = renderToStaticMarkup(
      <LoadBalancerPanel
        selectedNamespace="team-a"
        loadBalancers={{
          active_connections: [
            { namespace: "team-a", upstream_id: "own-upstream", targets: { "a:80": 1 } },
            { namespace: "ferrum", upstream_id: "other-upstream", targets: { "b:80": 2 } },
          ],
        }}
      />,
    );
    expect(html).toContain("ns ferrum");
    expect(html).not.toContain("ns team-a");
  });

  it("labels circuit breakers outside the selected namespace", () => {
    const breaker = { proxy_id: "orders", state: "open" as const, failure_count: 3, success_count: 0 };
    const html = renderToStaticMarkup(
      <CircuitBreakerPanel
        selectedNamespace="team-a"
        breakers={[
          { ...breaker, namespace: "team-a" },
          { ...breaker, namespace: "team-b" },
        ]}
      />,
    );
    expect(html).toContain("ns team-b");
    expect(html).not.toContain("ns team-a");
  });

  it("labels unhealthy targets outside the selected namespace", () => {
    const target = { target: "10.0.0.1:80", type: "active" as const, since_epoch_ms: 0 };
    const html = renderToStaticMarkup(
      <HealthCheckPanel
        selectedNamespace="ferrum"
        healthCheck={{
          unhealthy_target_count: 2,
          unhealthy_targets: [
            { ...target, namespace: "ferrum", upstream_id: "u1" },
            { ...target, namespace: "team-a", upstream_id: "u1" },
          ],
        }}
      />,
    );
    expect(html).toContain("ns team-a");
    expect(html).not.toContain("ns ferrum");
  });

  it("keys unhealthy targets by namespace, check kind, owner and target", () => {
    const base: AdminMetricsUnhealthyTarget = {
      namespace: "ferrum", target: "10.0.0.1:80", type: "active", since_epoch_ms: 0,
    };
    const rows: AdminMetricsUnhealthyTarget[] = [
      { ...base, upstream_id: "u1" },
      { ...base, upstream_id: "u2" },
      { ...base, upstream_id: "u1", type: "passive" },
      { ...base, upstream_id: "u1", namespace: "team-a" },
      { ...base, proxy_id: "p1" },
    ];
    expect(new Set(rows.map(unhealthyTargetKey)).size).toBe(rows.length);
  });
});
