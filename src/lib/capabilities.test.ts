import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SURFACES,
  isGatewayRole,
  resolveCapabilities,
  resolveCapability,
  resolveGatewayWriteState,
  type CapabilityFacts,
  type GatewayRole,
} from "./capabilities";

function facts(
  role: GatewayRole | null,
  mode: string | null,
  adminWritesEnabled: boolean | null = mode === null ? null : true,
): CapabilityFacts {
  return { role, mode, adminWritesEnabled };
}

describe("gateway write state", () => {
  it("is unknown until a health snapshot is actually read", () => {
    expect(resolveGatewayWriteState(facts("admin", null))).toEqual({ state: "unknown" });
  });

  it("is enabled on a writable database-mode gateway", () => {
    expect(resolveGatewayWriteState(facts("admin", "database"))).toEqual({ state: "enabled" });
  });

  it.each(["file", "dp", "mesh", "FILE", " file "])(
    "is read-only in %s mode",
    (mode) => {
      const state = resolveGatewayWriteState(facts("admin", mode));
      expect(state.state).toBe("read-only");
      expect(state.state === "read-only" && state.explanation).toContain("read-only");
    },
  );

  it("is read-only when the gateway reports admin writes disabled", () => {
    const state = resolveGatewayWriteState(facts("admin", "database", false));
    expect(state.state).toBe("read-only");
    expect(state.state === "read-only" && state.explanation).toContain("admin writes are disabled");
  });
});

describe("role x mode capability matrix", () => {
  it("lets a viewer read but never write on a writable gateway", () => {
    const capabilities = resolveCapabilities(facts("viewer", "database"));
    for (const surface of CAPABILITY_SURFACES) {
      expect(capabilities[surface].allowed).toBe(false);
      expect(capabilities[surface].blockedBy).toBe("role");
      expect(capabilities[surface].explanation).toContain("viewer role");
    }
  });

  it("grants an operator the operator surfaces and withholds the admin ones", () => {
    const capabilities = resolveCapabilities(facts("operator", "database"));
    expect(capabilities.proxies.allowed).toBe(true);
    expect(capabilities.upstreams.allowed).toBe(true);
    expect(capabilities.pluginConfigs.allowed).toBe(true);
    expect(capabilities.operationalActions.allowed).toBe(true);

    for (const surface of [
      "consumers",
      "consumerCredentials",
      "apiSpecs",
      "namespaceRegistry",
      "configExport",
      "configBackup",
      "gatewayTrust",
      "tlsMaterial",
      "bffSettings",
    ] as const) {
      expect(capabilities[surface].allowed).toBe(false);
      expect(capabilities[surface].blockedBy).toBe("role");
      expect(capabilities[surface].explanation).toContain("admin role");
    }
  });

  it("grants an admin every surface on a writable gateway", () => {
    const capabilities = resolveCapabilities(facts("admin", "database"));
    for (const surface of CAPABILITY_SURFACES) {
      expect(capabilities[surface]).toEqual({
        allowed: true,
        label: capabilities[surface].label,
        headline: capabilities[surface].headline,
      });
    }
  });

  it("withholds every configuration write from an admin on a file-mode gateway", () => {
    const capabilities = resolveCapabilities(facts("admin", "file", null));
    for (const surface of [
      "proxies",
      "upstreams",
      "pluginConfigs",
      "consumers",
      "consumerCredentials",
      "apiSpecs",
      "namespaceRegistry",
      "configBackup",
      "gatewayTrust",
    ] as const) {
      expect(capabilities[surface].allowed).toBe(false);
      expect(capabilities[surface].blockedBy).toBe("gateway-read-only");
      expect(capabilities[surface].explanation).toContain("file mode");
    }
  });

  it("keeps TLS material, operational actions, and BFF settings off the config-store gate", () => {
    const capabilities = resolveCapabilities(facts("admin", "file", false));
    expect(capabilities.tlsMaterial.allowed).toBe(true);
    expect(capabilities.operationalActions.allowed).toBe(true);
    expect(capabilities.bffSettings.allowed).toBe(true);
    expect(capabilities.configExport.allowed).toBe(true);
  });

  it("reports the role denial ahead of the gateway-mode denial", () => {
    const verdict = resolveCapability("proxies", facts("viewer", "file", false));
    expect(verdict.blockedBy).toBe("role");
    expect(verdict.summary).toBe("Requires the operator role");
    expect(verdict.headline).toBe("Proxy configuration is read-only");
  });

  it("concludes nothing while the role and the health snapshot are unknown", () => {
    const capabilities = resolveCapabilities(facts(null, null));
    for (const surface of CAPABILITY_SURFACES) {
      expect(capabilities[surface].allowed).toBe(true);
      expect(capabilities[surface].explanation).toBeUndefined();
    }
  });

  it("still withholds admin surfaces from a viewer whose gateway mode is unknown", () => {
    const capabilities = resolveCapabilities(facts("viewer", null));
    expect(capabilities.proxies.allowed).toBe(false);
    expect(capabilities.proxies.blockedBy).toBe("role");
  });
});

describe("role parsing", () => {
  it("accepts only the three gateway roles", () => {
    expect(isGatewayRole("viewer")).toBe(true);
    expect(isGatewayRole("operator")).toBe(true);
    expect(isGatewayRole("admin")).toBe(true);
    expect(isGatewayRole("root")).toBe(false);
    expect(isGatewayRole(undefined)).toBe(false);
  });
});
