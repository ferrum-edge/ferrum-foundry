import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminMetricsSnapshot } from "@/test/__tests__/adminMetricsFixtures";
import { detailedHealth } from "@/test/__tests__/healthFixtures";
import DashboardPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" }, selectedNamespace: "ferrum" }),
}));
// The Foundry connection card and navigation links are not under test.
vi.mock("@/components/shared/BffConnectionCard", () => ({ BffConnectionCard: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

function renderDashboard(mode: string, edit?: (m: ReturnType<typeof adminMetricsSnapshot>) => void): string {
  const client = new QueryClient();
  try {
    const metrics = adminMetricsSnapshot(mode);
    edit?.(metrics);
    client.setQueryData(["adminMetrics", "ferrum"], metrics);
    client.setQueryData(["health", "ferrum"], { ...detailedHealth, mode });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const RESOURCE_AND_TRAFFIC = [">Proxies<", ">Consumers<", ">Upstreams<", ">Plugins<", ">Requests / sec<", ">Uptime<"];

describe("dashboard mode shapes", () => {
  it.each([
    ["cp", "Control plane", "Online", "Not reported by a control plane"],
    ["node_agent", "Node agent", "Not applicable", "Not reported by a node agent"],
  ])("shows %s mode, version and source instead of placeholder counts", (mode, label, source, unavailable) => {
    const html = renderDashboard(mode);
    expect(html).toContain(`>${label}</p>`);
    expect(html).toContain(`gateway.mode: ${mode}`);
    expect(html).toContain(">Ferrum Version<");
    expect(html).toContain(">0.9.20</p>");
    expect(html).toContain(">Config Source<");
    expect(html).toContain(`>${source}</p>`);
    expect(html).toContain(unavailable);
    for (const card of RESOURCE_AND_TRAFFIC) expect(html).not.toContain(card);
    expect(html).not.toContain(">0m</p>");
    expect(html).not.toContain(">0</p>");
    // Quick navigation stays.
    expect(html).toContain("Manage Proxies");
  });

  it("warns on an offline control-plane config source", () => {
    const html = renderDashboard("cp", (m) => { m.gateway.config_source_status = "offline"; });
    expect(html).toContain(">Offline</p>");
    expect(html).toContain("text-warning");
  });

  it.each(["database", "file", "dp", "mesh"])("keeps genuine measured zeros visible in %s mode", (mode) => {
    const html = renderDashboard(mode);
    for (const card of RESOURCE_AND_TRAFFIC) expect(html).toContain(card);
    expect(html).toContain(">0m</p>");
    expect(html).toContain(">0</p>");
    expect(html).toContain(">0.9.20</p>");
    expect(html).not.toContain("Not reported by");
    expect(html).not.toContain(">Config Source<");
  });

  it("shows proxy-mode breaker alerts and unhealthy targets", () => {
    const html = renderDashboard("dp", (m) => {
      m.circuit_breakers = [{ namespace: "ferrum", proxy_id: "orders", state: "open", failure_count: 5, success_count: 0 }];
      m.health_check = {
        unhealthy_target_count: 1,
        unhealthy_targets: [{ namespace: "ferrum", target: "10.0.0.1:8080", type: "active", since_epoch_ms: 1 }],
      };
    });
    expect(html).toContain("Circuit Breaker Alerts");
    expect(html).toContain("Unhealthy Targets");
  });
});
