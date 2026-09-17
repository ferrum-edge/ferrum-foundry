/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – client-side capability model                      */
/*                                                                     */
/*  Mirrors, never replaces, the gateway's own authorization matrix.   */
/*  Ferrum Edge and the BFF still authorize every request; this model  */
/*  exists so the UI does not present a mutation form whose only       */
/*  possible outcome is a 403.                                         */
/*                                                                     */
/*  Two facts drive it, both of which the UI already reads:            */
/*                                                                     */
/*    * the authenticated role on the Foundry session principal        */
/*      (`viewer` / `operator` / `admin`), and                         */
/*    * the gateway's operating mode plus `admin_writes_enabled` from  */
/*      the authenticated `/health` snapshot.                          */
/*                                                                     */
/*  Read truthfulness applies: a fact that has not been read is `null` */
/*  and never concludes anything. An unknown role or an unread health  */
/*  snapshot leaves the surface enabled and lets the server answer.    */
/*  Only a positively observed denial renders a surface read-only.     */
/* ------------------------------------------------------------------ */

export type GatewayRole = "viewer" | "operator" | "admin";

/** Ranking used by both Ferrum Edge and the BFF's own `requireRole`. */
const ROLE_RANK: Record<GatewayRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

export function isGatewayRole(value: unknown): value is GatewayRole {
  return value === "viewer" || value === "operator" || value === "admin";
}

/**
 * Gateway operating modes whose admin API is documented read-only for
 * configuration: the configuration is owned by a config file, by the control
 * plane, or by mesh policy sources rather than by an admin-writable store.
 */
const READ_ONLY_MODES = new Set(["file", "dp", "mesh"]);

const MODE_EXPLANATIONS: Record<string, string> = {
  file:
    "The gateway runs in file mode: its configuration comes from a config file " +
    "and the admin API is read-only. Edit the gateway's file and reload it instead.",
  dp:
    "The gateway runs in data-plane (dp) mode: its configuration comes from the " +
    "control plane and the admin API is read-only.",
  mesh:
    "The gateway runs in mesh mode: its configuration comes from mesh policy " +
    "sources and the admin API is read-only.",
};

const WRITES_DISABLED_EXPLANATION =
  "The gateway reports that admin writes are disabled — a read-only admin API, " +
  "an unavailable configuration database, or a failover topology that does not " +
  "allow writes.";

/** Surfaces the UI can present a write for. */
export type CapabilitySurface =
  | "proxies"
  | "upstreams"
  | "pluginConfigs"
  | "consumers"
  | "consumerCredentials"
  | "apiSpecs"
  | "namespaceRegistry"
  | "configExport"
  | "configBackup"
  | "gatewayTrust"
  | "tlsMaterial"
  | "operationalActions"
  | "bffSettings";

export type CapabilityBlocker = "role" | "gateway-read-only";

export interface CapabilityVerdict {
  /** False only when a read fact positively proves the write would be denied. */
  allowed: boolean;
  /** Human-readable surface name, safe to render in a heading. */
  label: string;
  /** Full sentence heading for the read-only notice, e.g. "X is read-only". */
  headline: string;
  blockedBy?: CapabilityBlocker;
  /** A few words naming the block, for a note beside a single action. */
  summary?: string;
  /** One or two sentences naming why, rendered beside the read-only surface. */
  explanation?: string;
}

export type CapabilitySet = Record<CapabilitySurface, CapabilityVerdict>;

export interface CapabilityFacts {
  /** The session principal's role, or `null` while the session is unknown. */
  role: GatewayRole | null;
  /** `health.mode`, or `null` when the health snapshot has not been read. */
  mode: string | null;
  /** `health.admin_writes_enabled`, or `null` when it was not observed. */
  adminWritesEnabled: boolean | null;
}

interface SurfaceDescriptor {
  label: string;
  /** Notice heading. Editing surfaces read "read-only"; actions "unavailable". */
  headline: string;
  /** Verb phrase completing "The <role> role cannot <action>." */
  action: string;
  minimumRole: GatewayRole;
  /**
   * True when the surface persists into the gateway's configuration store and
   * is therefore covered by read-only mode and `admin_writes_enabled`.
   *
   * Managed TLS/ACME material lives in independent stores that
   * `admin_writes_enabled` deliberately does not gate, operational POSTs
   * (rotate, validate, refresh, dry-run) persist no configuration at all, and
   * BFF settings never reach the gateway — all three stay role-only.
   */
  configStore: boolean;
}

/**
 * Role requirements follow the upstream contract in `openapi.yaml`: `viewer`
 * reads, `operator` additionally mutates proxies, upstreams, plugin configs
 * and operational endpoints, and `admin` covers consumers, credentials, API
 * specs, TLS material, gateway trust, batch/restore, the namespace registry,
 * and audit.
 */
const SURFACES: Record<CapabilitySurface, SurfaceDescriptor> = {
  proxies: {
    label: "Proxy configuration",
    headline: "Proxy configuration is read-only",
    action: "create, edit, or delete proxies",
    minimumRole: "operator",
    configStore: true,
  },
  upstreams: {
    label: "Upstream configuration",
    headline: "Upstream configuration is read-only",
    action: "create, edit, or delete upstreams and their targets",
    minimumRole: "operator",
    configStore: true,
  },
  pluginConfigs: {
    label: "Plugin configuration",
    headline: "Plugin configuration is read-only",
    action: "create, edit, or delete plugin configurations",
    minimumRole: "operator",
    configStore: true,
  },
  consumers: {
    label: "Consumer configuration",
    headline: "Consumer configuration is read-only",
    action: "create, edit, or delete consumers",
    minimumRole: "admin",
    configStore: true,
  },
  consumerCredentials: {
    label: "Consumer credentials",
    headline: "Consumer credentials are read-only",
    action: "add, rotate, or revoke consumer credentials",
    minimumRole: "admin",
    configStore: true,
  },
  apiSpecs: {
    label: "API spec import",
    headline: "API spec import is unavailable",
    action: "import, replace, or delete API specs",
    minimumRole: "admin",
    configStore: true,
  },
  namespaceRegistry: {
    label: "Namespace registry",
    headline: "The namespace registry is read-only",
    action: "create, rename, or delete namespaces",
    minimumRole: "admin",
    configStore: true,
  },
  configExport: {
    label: "Configuration export",
    headline: "Configuration export is unavailable",
    action: "export the gateway configuration",
    minimumRole: "admin",
    configStore: false,
  },
  configBackup: {
    label: "Configuration restore",
    headline: "Configuration restore is unavailable",
    action: "restore a configuration backup",
    minimumRole: "admin",
    configStore: true,
  },
  gatewayTrust: {
    label: "Gateway trust bundle",
    headline: "The gateway trust bundle is read-only",
    action: "create, edit, or delete the gateway trust bundle",
    minimumRole: "admin",
    configStore: true,
  },
  tlsMaterial: {
    label: "Managed TLS material",
    headline: "Managed TLS material is read-only",
    action: "upload or delete managed TLS material",
    minimumRole: "admin",
    configStore: false,
  },
  operationalActions: {
    label: "Operational gateway actions",
    headline: "Operational gateway actions are unavailable",
    action: "run operational gateway actions",
    minimumRole: "operator",
    configStore: false,
  },
  bffSettings: {
    label: "BFF connection settings",
    headline: "BFF connection settings are read-only",
    action: "change the Foundry BFF connection settings",
    minimumRole: "admin",
    configStore: false,
  },
};

export const CAPABILITY_SURFACES = Object.keys(SURFACES) as CapabilitySurface[];

export type GatewayWriteState =
  | { state: "enabled" }
  | { state: "read-only"; explanation: string }
  | { state: "unknown" };

/**
 * Classify whether the gateway will accept configuration writes at all.
 * `unknown` is the honest answer whenever neither signal was observed.
 */
export function resolveGatewayWriteState(facts: CapabilityFacts): GatewayWriteState {
  const mode = typeof facts.mode === "string" ? facts.mode.trim().toLowerCase() : null;
  if (mode && READ_ONLY_MODES.has(mode)) {
    return {
      state: "read-only",
      explanation:
        MODE_EXPLANATIONS[mode] ??
        `The gateway runs in ${mode} mode, where the admin API is read-only.`,
    };
  }
  if (facts.adminWritesEnabled === false) {
    return { state: "read-only", explanation: WRITES_DISABLED_EXPLANATION };
  }
  if (facts.adminWritesEnabled === true) return { state: "enabled" };
  return { state: "unknown" };
}

/** Resolve one surface. Role denials are reported ahead of mode denials. */
export function resolveCapability(
  surface: CapabilitySurface,
  facts: CapabilityFacts,
): CapabilityVerdict {
  const descriptor = SURFACES[surface];
  const { label, headline, action, minimumRole } = descriptor;

  if (facts.role && ROLE_RANK[facts.role] < ROLE_RANK[minimumRole]) {
    return {
      allowed: false,
      label,
      headline,
      blockedBy: "role",
      summary: `Requires the ${minimumRole} role`,
      explanation:
        `Your session has the ${facts.role} role, which cannot ${action}. ` +
        `Ferrum Edge requires the ${minimumRole} role for this surface.`,
    };
  }

  if (descriptor.configStore) {
    const writeState = resolveGatewayWriteState(facts);
    if (writeState.state === "read-only") {
      return {
        allowed: false,
        label,
        headline,
        blockedBy: "gateway-read-only",
        summary: "The gateway admin API is read-only",
        explanation: writeState.explanation,
      };
    }
  }

  return { allowed: true, label, headline };
}

/** Resolve every surface at once; the hook memoizes this per fact change. */
export function resolveCapabilities(facts: CapabilityFacts): CapabilitySet {
  const set = {} as CapabilitySet;
  for (const surface of CAPABILITY_SURFACES) {
    set[surface] = resolveCapability(surface, facts);
  }
  return set;
}
