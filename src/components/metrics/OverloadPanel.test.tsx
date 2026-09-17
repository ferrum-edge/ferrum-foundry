import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OverloadSnapshot, PressureGauge } from "@/api/ops";
import { OverloadPanel } from "./OpsPanels";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" }, selectedNamespace: "ferrum" }),
}));

const finiteDescriptors = {
  current: 812,
  max: 65536,
  ratio: 0.012,
  enforced: true as const,
};
const finiteConnections: PressureGauge = { current: 342, max: 20000, ratio: 0.017 };
const finiteRequests: PressureGauge = { current: 57, max: 8000, ratio: 0.007 };

function snapshot(pressure: OverloadSnapshot["pressure"]): OverloadSnapshot {
  return { level: "normal", pressure };
}

function renderOverload(data: OverloadSnapshot): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    client.setQueryData(["overload"], data);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OverloadPanel refetchInterval={false} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

describe("OverloadPanel pressure gauges", () => {
  it("renders finite enforced limits as current / max without disabled copy", () => {
    const html = renderOverload(snapshot({
      file_descriptors: finiteDescriptors,
      connections: finiteConnections,
      requests: finiteRequests,
    }));
    expect(html).toContain("NORMAL");
    expect(html).toContain("File descriptors");
    expect(html).toContain("812 / 65536");
    expect(html).toContain("342 / 20000");
    expect(html).toContain("57 / 8000");
    expect(html).not.toContain("not enforced");
    expect(html).not.toContain("no limit configured");
    expect(html).not.toContain("FD-based load shedding is disabled");
  });

  it("renders an over-limit finite gauge as current / max, not as unconfigured", () => {
    const html = renderOverload(snapshot({
      file_descriptors: finiteDescriptors,
      connections: { current: 200, max: 100, ratio: 1 },
      requests: finiteRequests,
    }));
    expect(html).toContain("200 / 100");
    expect(html).not.toContain("no limit configured");
    expect(html).not.toContain("200 / 0");
  });

  it("renders disabled FD protection without a misleading current / 0 ratio", () => {
    const html = renderOverload(snapshot({
      file_descriptors: { current: 120, max: 0, ratio: 0, enforced: false },
      connections: { current: 0, max: 100000, ratio: 0 },
      requests: finiteRequests,
    }));
    expect(html).toContain("File descriptors");
    expect(html).toContain("not enforced");
    expect(html).toContain("120 open");
    expect(html).toContain("FD-based load shedding is disabled");
    expect(html).toContain("no enforceable descriptor ceiling");
    expect(html).toContain("0 / 100000");
    expect(html).toContain("57 / 8000");
    expect(html).not.toContain("120 / 0");
    expect(html).not.toContain("no limit configured");
  });

  it("renders an unconfigured request limit separately from a zero-capacity ratio", () => {
    const html = renderOverload(snapshot({
      file_descriptors: finiteDescriptors,
      connections: finiteConnections,
      requests: { current: 0, max: 0, ratio: 0 },
    }));
    expect(html).toContain("In-flight requests");
    expect(html).toContain("no limit configured");
    expect(html).toContain("No in-flight request limit is configured.");
    expect(html).toContain("812 / 65536");
    expect(html).toContain("342 / 20000");
    expect(html).not.toContain("0 / 0");
    expect(html).not.toContain("not enforced");
  });

  it("renders the live disabled-FD plus unconfigured-request snapshot honestly", () => {
    const html = renderOverload({
      level: "normal",
      pressure: {
        file_descriptors: { current: 120, max: 0, ratio: 0, enforced: false },
        connections: { current: 0, max: 100000, ratio: 0 },
        requests: { current: 0, max: 0, ratio: 0 },
      },
    });
    expect(html).toContain("NORMAL");
    expect(html).toContain("not enforced");
    expect(html).toContain("120 open");
    expect(html).toContain("FD-based load shedding is disabled");
    expect(html).toContain("no limit configured");
    expect(html).toContain("No in-flight request limit is configured.");
    expect(html).toContain("0 / 100000");
    expect(html).not.toContain("120 / 0");
    expect(html).not.toContain("0 / 0");
  });
});
