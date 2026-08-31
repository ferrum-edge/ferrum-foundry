import { describe, expect, it } from "vitest";
import { getPluginConfigDefault } from "./pluginConfigDefaults";

describe("canonical plugin defaults", () => {
  it("uses the closed correlation_id shape", () => {
    expect(getPluginConfigDefault("correlation_id")).toEqual({
      header_name: "X-Correlation-ID",
      echo_downstream: true,
    });
  });

  it("places rate windows inside the required limits rules", () => {
    expect(getPluginConfigDefault("rate_limiting")).toEqual({
      limit_by: "consumer",
      expose_headers: true,
      limits: [{
        scope: "default",
        requests_per_second: 400,
        requests_per_minute: 20000,
      }],
      sync_mode: "local",
    });
  });
});
