import { describe, expect, it } from "vitest";
import type { ActiveHealthCheck, PassiveHealthCheck } from "@/api/types";
import { healthCheckLabel } from "./index";

// Issue #683: the list named passive-only checks "Active", which is also the
// name of the other check kind.
describe("healthCheckLabel", () => {
  const active = {} as ActiveHealthCheck;
  const passive = {} as PassiveHealthCheck;

  it("names the configured check kinds", () => {
    expect(healthCheckLabel({ active })).toBe("Active");
    expect(healthCheckLabel({ passive })).toBe("Passive");
    expect(healthCheckLabel({ active, passive })).toBe("Active + passive");
  });

  it("reports no checks when neither kind is present", () => {
    expect(healthCheckLabel(undefined)).toBeNull();
    expect(healthCheckLabel(null)).toBeNull();
    expect(healthCheckLabel({ active: null, passive: null })).toBeNull();
  });
});
