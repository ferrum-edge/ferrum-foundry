import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SURFACES,
  capabilityRequirement,
  isGatewayRole,
  resolveCapabilities,
  resolveCapability,
  resolveGatewayWriteState,
  resolveReadOnlyModeState,
  type CapabilityFacts,
  type CapabilitySurface,
  type GatewayRole,
} from "./capabilities";

/**
 * Surfaces behind `AdminState::admit_write`, observable as
 * `admin_writes_enabled` (ferrum-edge `src/admin/mod.rs:499`).
 */
const CONFIG_STORE_SURFACES: readonly CapabilitySurface[] = [
  "proxies",
  "upstreams",
  "pluginConfigs",
  "consumers",
  "consumerCredentials",
  "apiSpecs",
  "namespaceRegistry",
  "configBackup",
  "gatewayTrust",
];

/**
 * Surfaces behind `admit_non_config_db_write`: refused in a read-only mode,
 * but not covered by the config-DB failover gate `admin_writes_enabled` also
 * folds in (ferrum-edge `src/admin/mod.rs:813`).
 */
const READ_ONLY_MODE_SURFACES: readonly CapabilitySurface[] = ["tlsMaterial"];

/** Surfaces the gateway applies no write gate to at all. */
const UNGATED_SURFACES: readonly CapabilitySurface[] = [
  "tlsRotation",
  "operationalActions",
  "fleetOperations",
  "configExport",
  "bffSettings",
];

/**
 * Fleet-wide writes the BFF refuses to a session holding namespace grants:
 * every TLS mutation except validate, the backend-capability refresh, and the
 * mesh egress dry-run (`server/proxy-path.ts`), and `PUT /api/settings`
 * (`server/routes/settings.ts`).
 */
const FLEET_WIDE_SURFACES: readonly CapabilitySurface[] = [
  "tlsMaterial",
  "tlsRotation",
  "fleetOperations",
  "bffSettings",
];

/** Modes that report `read_only: true` unconditionally. */
const READ_ONLY_MODES: readonly string[] = ["file", "dp", "mesh", "node_agent"];
/** The mode phrase each read-only explanation names (see `MODE_EXPLANATIONS`). */
const MODE_PHRASE: Record<string, string> = {
  file: "file mode",
  dp: "data-plane (dp) mode",
  mesh: "mesh mode",
  node_agent: "node-agent mode",
};

function facts(
  role: GatewayRole | null,
  mode: string | null,
  adminWritesEnabled: boolean | null = mode === null ? null : true,
  status: string | null = null,
  namespaceScoped: boolean | null = null,
): CapabilityFacts {
  return { role, namespaceScoped, mode, adminWritesEnabled, status };
}

describe("gateway write state", () => {
  it("is unknown until a health snapshot is actually read", () => {
    expect(resolveGatewayWriteState(facts("admin", null))).toEqual({ state: "unknown" });
  });

  it("is enabled on a writable database-mode gateway", () => {
    expect(resolveGatewayWriteState(facts("admin", "database"))).toEqual({ state: "enabled" });
  });

  it.each([...READ_ONLY_MODES, "FILE", " file "])(
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
    expect(capabilities.tlsRotation.allowed).toBe(true);
    expect(capabilities.operationalActions.allowed).toBe(true);
    expect(capabilities.fleetOperations.allowed).toBe(true);

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

  it.each(READ_ONLY_MODES)(
    "withholds every gated write from an admin on a %s-mode gateway",
    (mode) => {
      const capabilities = resolveCapabilities(facts("admin", mode, null));
      // Both gate kinds deny here: `admit_write` and
      // `admit_non_config_db_write` each start with the read-only gate.
      for (const surface of [...CONFIG_STORE_SURFACES, ...READ_ONLY_MODE_SURFACES]) {
        expect(capabilities[surface].allowed).toBe(false);
        expect(capabilities[surface].blockedBy).toBe("gateway-read-only");
        expect(capabilities[surface].explanation).toContain(MODE_PHRASE[mode]);
      }
      expect(capabilities.tlsRotation.allowed).toBe(true);
      expect(capabilities.operationalActions.allowed).toBe(true);
      expect(capabilities.fleetOperations.allowed).toBe(true);
      expect(capabilities.bffSettings.allowed).toBe(true);
      if (mode === "node_agent") {
        expect(capabilities.configExport.allowed).toBe(false);
        expect(capabilities.configExport.blockedBy).toBe("gateway-read-only");
        expect(capabilities.configExport.explanation).toContain("node-agent mode");
        expect(capabilities.configExport.explanation).toContain("cached configuration");
      } else {
        expect(capabilities.configExport.allowed).toBe(true);
      }
    },
  );

  it("refuses managed TLS material in a read-only mode", () => {
    // ferrum-edge `src/admin/tls_management.rs` routes all 18 managed TLS/ACME
    // mutations through `admit_non_config_db_write`, whose first step is
    // `admit_read_only_gate` (`src/admin/mod.rs:813`).
    const verdict = resolveCapability("tlsMaterial", facts("admin", "file", null));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe("gateway-read-only");
    expect(verdict.explanation).toContain("file mode");
  });

  it("keeps managed TLS material off the config-store gate on a writable mode", () => {
    // `admin_writes_enabled` is `!admin_writes_currently_blocked()`, which also
    // folds in the sticky config-DB failover gate. That gate does not reach the
    // independent TLS/ACME stores, so denying them from writes-disabled alone
    // (no non-degraded status) would be invented.
    const capabilities = resolveCapabilities(facts("admin", "database", false));
    expect(capabilities.tlsMaterial.allowed).toBe(true);
    expect(capabilities.proxies.allowed).toBe(false);
    expect(capabilities.proxies.blockedBy).toBe("gateway-read-only");
  });

  it("denies configuration export on node_agent because there is no cached config", () => {
    const verdict = resolveCapability("configExport", facts("admin", "node_agent", null));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe("gateway-read-only");
    expect(verdict.explanation).toContain("node-agent mode");
    expect(verdict.explanation).toContain("cached configuration");
    expect(resolveCapability("configExport", facts("admin", "file", null)).allowed).toBe(true);
  });

  it("keeps operational actions and BFF settings off every gateway gate", () => {
    for (const mode of [...READ_ONLY_MODES, "database"]) {
      const capabilities = resolveCapabilities(facts("admin", mode, false));
      expect(capabilities.operationalActions.allowed).toBe(true);
      expect(capabilities.bffSettings.allowed).toBe(true);
    }
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

describe("namespace-scoped sessions", () => {
  it("withholds every fleet-wide write from a scoped admin and keeps the rest", () => {
    const capabilities = resolveCapabilities(facts("admin", "database", true, "ok", true));
    for (const surface of CAPABILITY_SURFACES) {
      const verdict = capabilities[surface];
      if (FLEET_WIDE_SURFACES.includes(surface)) {
        expect(verdict.allowed, surface).toBe(false);
        expect(verdict.blockedBy, surface).toBe("namespace-scope");
        expect(verdict.summary).toBe("Requires an administrator without namespace grants");
        expect(verdict.explanation).toContain("namespace grants do not scope");
      } else {
        expect(verdict.allowed, surface).toBe(true);
      }
    }
    // Validation is stateless and stays available to a scoped session.
    expect(capabilities.operationalActions.allowed).toBe(true);
  });

  it("names TLS rotation as a fleet-wide action an operator otherwise holds", () => {
    const scoped = resolveCapability("tlsRotation", facts("operator", "file", null, null, true));
    expect(scoped.allowed).toBe(false);
    expect(scoped.blockedBy).toBe("namespace-scope");
    expect(scoped.headline).toBe("TLS rotation is unavailable");
    expect(resolveCapability("tlsRotation", facts("operator", "file", null, null, false)).allowed)
      .toBe(true);
  });

  it("names the backend-capability refresh and egress dry-run as fleet-wide", () => {
    const scoped = resolveCapability(
      "fleetOperations",
      facts("operator", "database", true, "ok", true),
    );
    expect(scoped.allowed).toBe(false);
    expect(scoped.blockedBy).toBe("namespace-scope");
    expect(scoped.headline).toBe("Fleet operational actions are unavailable");
    const unscoped = resolveCapability(
      "fleetOperations",
      facts("operator", "database", true, "ok", false),
    );
    expect(unscoped.allowed).toBe(true);
  });

  it("reports the role denial ahead of the namespace-scope denial", () => {
    const verdict = resolveCapability("tlsMaterial", facts("operator", "database", true, "ok", true));
    expect(verdict.blockedBy).toBe("role");
    expect(verdict.summary).toBe("Requires the admin role");
  });

  it("reports the namespace-scope denial ahead of the gateway-mode denial", () => {
    const verdict = resolveCapability("tlsMaterial", facts("admin", "file", null, null, true));
    expect(verdict.blockedBy).toBe("namespace-scope");
  });

  it.each([false, null])("concludes nothing from namespace grants that are %s", (namespaceScoped) => {
    const capabilities = resolveCapabilities(facts("admin", "database", true, "ok", namespaceScoped));
    for (const surface of FLEET_WIDE_SURFACES) {
      expect(capabilities[surface].allowed, surface).toBe(true);
    }
  });

  it("concludes nothing when a caller supplies no namespace fact", () => {
    // The parity contract passes role and health facts only.
    const unscopedFacts = { role: "admin", mode: "database", adminWritesEnabled: true, status: "ok" };
    const verdict = resolveCapability("tlsMaterial", unscopedFacts as unknown as CapabilityFacts);
    expect(verdict.allowed).toBe(true);
  });
});

describe("read-only-mode gate", () => {
  it.each(READ_ONLY_MODES)("reports %s mode read-only", (mode) => {
    const state = resolveReadOnlyModeState(facts("admin", mode, true));
    expect(state.state).toBe("read-only");
  });

  it("stays unknown on a writable mode when writes are disabled without a status", () => {
    // `FERRUM_ADMIN_READ_ONLY` on a database/cp gateway is invisible in the
    // mode string. Without an observed health status the third case cannot
    // distinguish it from failover, so this gate concludes nothing.
    expect(resolveReadOnlyModeState(facts("admin", "database", false))).toEqual({
      state: "unknown",
    });
    expect(resolveReadOnlyModeState(facts("admin", null))).toEqual({ state: "unknown" });
  });

  it("treats writes-disabled plus status ok as admin read-only on database/cp", () => {
    // handle_health forces status: "degraded" when writes are blocked AND the
    // process is not read-only. status: "ok" with admin_writes_enabled: false
    // on a writable mode is therefore FERRUM_ADMIN_READ_ONLY.
    for (const mode of ["database", "cp"] as const) {
      const state = resolveReadOnlyModeState(facts("admin", mode, false, "ok"));
      expect(state.state).toBe("read-only");
      expect(state.state === "read-only" && state.explanation).toContain("FERRUM_ADMIN_READ_ONLY");
      const capabilities = resolveCapabilities(facts("admin", mode, false, "ok"));
      for (const surface of READ_ONLY_MODE_SURFACES) {
        expect(capabilities[surface].allowed).toBe(false);
        expect(capabilities[surface].blockedBy).toBe("gateway-read-only");
        expect(capabilities[surface].explanation).toContain("FERRUM_ADMIN_READ_ONLY");
      }
      expect(capabilities.proxies.allowed).toBe(false);
      expect(capabilities.operationalActions.allowed).toBe(true);
    }
  });

  it("does not treat writes-disabled plus status degraded as read-only mode", () => {
    // Failover / DB-unavailable: handle_health forces degraded when writes are
    // blocked and the process is not read-only. That is a different gate.
    const state = resolveReadOnlyModeState(facts("admin", "database", false, "degraded"));
    expect(state).toEqual({ state: "unknown" });
    const capabilities = resolveCapabilities(facts("admin", "database", false, "degraded"));
    expect(capabilities.tlsMaterial.allowed).toBe(true);
    expect(capabilities.proxies.allowed).toBe(false);
  });

  it("still reports file mode read-only regardless of health status", () => {
    expect(resolveReadOnlyModeState(facts("admin", "file", false, "ok")).state).toBe("read-only");
    expect(resolveReadOnlyModeState(facts("admin", "file", false, "degraded")).state).toBe(
      "read-only",
    );
    const capabilities = resolveCapabilities(facts("admin", "file", false, "ok"));
    expect(capabilities.tlsMaterial.allowed).toBe(false);
    expect(capabilities.tlsMaterial.explanation).toContain("file mode");
  });
});

describe("surface gate lists", () => {
  it("partitions every capability surface across the three gate lists", () => {
    expect(
      [...CONFIG_STORE_SURFACES, ...READ_ONLY_MODE_SURFACES, ...UNGATED_SURFACES].sort(),
    ).toEqual([...CAPABILITY_SURFACES].sort());
  });
});

describe("capability requirements", () => {
  it("reports each surface's gate consistently with the gate lists", () => {
    for (const surface of CONFIG_STORE_SURFACES) {
      expect(capabilityRequirement(surface).gate).toBe("config-store");
    }
    for (const surface of READ_ONLY_MODE_SURFACES) {
      expect(capabilityRequirement(surface).gate).toBe("read-only-mode");
    }
    for (const surface of UNGATED_SURFACES) {
      expect(capabilityRequirement(surface).gate).toBe("none");
    }
  });

  it("reports the role the resolver actually enforces", () => {
    for (const surface of CAPABILITY_SURFACES) {
      const { minimumRole } = capabilityRequirement(surface);
      const verdict = resolveCapability(surface, facts("viewer", "database"));
      expect(verdict.allowed).toBe(minimumRole === "viewer");
      if (!verdict.allowed) expect(verdict.summary).toBe(`Requires the ${minimumRole} role`);
      expect(resolveCapability(surface, facts(minimumRole, "database")).allowed).toBe(true);
    }
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
