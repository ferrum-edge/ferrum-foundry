import { describe, expect, it } from "vitest";
import { backendProbesSupported, type ClusterStatus } from "./ops";

describe("backendProbesSupported", () => {
  it("is false only for control planes", () => {
    const cp: ClusterStatus = {
      mode: "cp",
      connected_data_planes: 1,
      connected_mesh_nodes: 0,
      data_planes: [],
      mesh_nodes: [],
    };
    const dp: ClusterStatus = {
      mode: "dp",
      control_plane: {
        url: "https://cp.example.test",
        status: "online",
        is_primary: true,
        config_diverged: false,
        config_divergence_recoveries_total: 0,
      },
    };
    expect(backendProbesSupported(cp)).toBe(false);
    expect(backendProbesSupported(dp)).toBe(true);
    expect(backendProbesSupported({ mode: "standalone", message: "Standalone gateway" })).toBe(true);
    expect(backendProbesSupported({ mode: "database", message: "database mode" })).toBe(true);
  });
});
