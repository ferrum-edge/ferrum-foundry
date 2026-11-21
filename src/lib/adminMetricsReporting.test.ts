import { describe, expect, it } from "vitest";
import { adminMetricsReporting, configSourceLabel } from "./adminMetricsReporting";

describe("adminMetricsReporting", () => {
  it.each([
    ["cp", "Control plane", "Not reported by a control plane", "A control plane holds no proxy state."],
    ["node_agent", "Node agent", "Not reported by a node agent", "A node agent holds no proxy state."],
  ])("treats %s proxy-runtime values as placeholders", (mode, modeLabel, unavailableLabel, detail) => {
    const reporting = adminMetricsReporting(mode);
    expect(reporting).toMatchObject({ mode, modeLabel, reportsProxyRuntime: false, unavailableLabel });
    expect(reporting.unavailableDetail).toContain(detail);
  });

  it.each([
    ["database", "Database"],
    ["file", "File"],
    ["dp", "Data plane"],
    ["mesh", "Mesh"],
  ])("reports proxy runtime as measured in %s mode", (mode, modeLabel) => {
    expect(adminMetricsReporting(mode)).toEqual({ mode, modeLabel, reportsProxyRuntime: true });
  });

  it("keeps an unknown mode's raw name and its values", () => {
    expect(adminMetricsReporting("future")).toEqual({ mode: "future", modeLabel: "future", reportsProxyRuntime: true });
  });

  it("labels every config source status", () => {
    expect(configSourceLabel("online")).toBe("Online");
    expect(configSourceLabel("offline")).toBe("Offline");
    expect(configSourceLabel("n/a")).toBe("Not applicable");
  });
});
