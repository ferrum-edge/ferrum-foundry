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
/*    * the gateway's operating mode, `admin_writes_enabled`, and      */
/*      `status` from the authenticated `/health` snapshot.            */
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
 * Gateway operating modes that report `read_only: true` unconditionally, so
 * every admin mutation behind Ferrum Edge's read-only gate is refused with
 * `403 {"error":"Admin API is in read-only mode"}`. The configuration is owned
 * by a config file, by the control plane, by mesh policy sources, or by the
 * node agent rather than by an admin-writable store. `database` and `cp` set
 * the same flag from `FERRUM_ADMIN_READ_ONLY`, which the mode string cannot
 * reveal. There they are observed through `admin_writes_enabled === false`
 * together with a health `status` that is not `"degraded"`.
 */
const READ_ONLY_MODES = new Set(["file", "dp", "mesh", "node_agent"]);

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
  node_agent:
    "The gateway runs in node-agent mode: it serves no admin configuration API " +
    "and its admin API is read-only.",
};

const WRITES_DISABLED_EXPLANATION =
  "The gateway reports that admin writes are disabled — a read-only admin API, " +
  "an unavailable configuration database, or a failover topology that does not " +
  "allow writes.";

const ADMIN_READ_ONLY_FLAG_EXPLANATION =
  "The gateway was started with FERRUM_ADMIN_READ_ONLY, so the admin API is read-only.";

const NODE_AGENT_EXPORT_EXPLANATION =
  "The gateway runs in node-agent mode: it has neither a configuration database " +
  "nor a cached configuration, so configuration export is unavailable.";

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
  /** `health.status`, or `null` when the health snapshot has not been read. */
  status: string | null;
}

/**
 * Which of Ferrum Edge's write-admission gates a surface passes through, on
 * top of its role requirement. The three kinds are not interchangeable:
 *
 * - `config-store` — `AdminState::admit_write`, reported observably as
 *   `admin_writes_enabled`. It folds read-only mode, an unavailable
 *   configuration database, **and** the sticky failover topology gate
 *   (`FERRUM_DB_FAILOVER_ALLOW_WRITES`) together.
 * - `read-only-mode` — `AdminState::admit_non_config_db_write`, which the
 *   managed TLS / ACME handlers call. It applies the read-only gate and the
 *   database-availability gate but deliberately **not** the failover-topology
 *   gate, because those stores are independent of the config database. An
 *   observed read-only *mode* denies it. On `database`/`cp`, so does
 *   `admin_writes_enabled === false` together with a health `status` that is
 *   not `"degraded"` (intentional `FERRUM_ADMIN_READ_ONLY`). Gating it on
 *   `admin_writes_enabled` alone would invent a failover-topology denial the
 *   gateway does not make.
 * - `none` — no gateway write gate at all: reads, operational actions
 *   (`admit_audited_operation`: rotate, validate, refresh, dry-run), and
 *   BFF-local writes that never reach the gateway.
 */
export type CapabilityGate = "config-store" | "read-only-mode" | "none";

interface SurfaceDescriptor {
  label: string;
  /** Notice heading. Editing surfaces read "read-only"; actions "unavailable". */
  headline: string;
  /** Verb phrase completing "The <role> role cannot <action>." */
  action: string;
  minimumRole: GatewayRole;
  /** The upstream write-admission gate this surface mirrors. */
  gate: CapabilityGate;
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
    gate: "config-store",
  },
  upstreams: {
    label: "Upstream configuration",
    headline: "Upstream configuration is read-only",
    action: "create, edit, or delete upstreams and their targets",
    minimumRole: "operator",
    gate: "config-store",
  },
  pluginConfigs: {
    label: "Plugin configuration",
    headline: "Plugin configuration is read-only",
    action: "create, edit, or delete plugin configurations",
    minimumRole: "operator",
    gate: "config-store",
  },
  consumers: {
    label: "Consumer configuration",
    headline: "Consumer configuration is read-only",
    action: "create, edit, or delete consumers",
    minimumRole: "admin",
    gate: "config-store",
  },
  consumerCredentials: {
    label: "Consumer credentials",
    headline: "Consumer credentials are read-only",
    action: "add, rotate, or revoke consumer credentials",
    minimumRole: "admin",
    gate: "config-store",
  },
  apiSpecs: {
    label: "API spec import",
    headline: "API spec import is unavailable",
    action: "import, replace, or delete API specs",
    minimumRole: "admin",
    gate: "config-store",
  },
  namespaceRegistry: {
    label: "Namespace registry",
    headline: "The namespace registry is read-only",
    action: "create, rename, or delete namespaces",
    minimumRole: "admin",
    gate: "config-store",
  },
  configExport: {
    label: "Configuration export",
    headline: "Configuration export is unavailable",
    action: "export the gateway configuration",
    minimumRole: "admin",
    // `GET /backup` is a read: `handle_backup` applies no write gate. file, dp,
    // and mesh populate `cached_config` and serve that when there is no
    // database. `node_agent` is the exception: it builds AdminState with
    // `db: None` and `cached_config: None`, so export returns 503.
    gate: "none",
  },
  configBackup: {
    label: "Configuration restore",
    headline: "Configuration restore is unavailable",
    action: "restore a configuration backup",
    minimumRole: "admin",
    gate: "config-store",
  },
  gatewayTrust: {
    label: "Gateway trust bundle",
    headline: "The gateway trust bundle is read-only",
    action: "create, edit, or delete the gateway trust bundle",
    minimumRole: "admin",
    gate: "config-store",
  },
  tlsMaterial: {
    label: "Managed TLS material",
    headline: "Managed TLS material is read-only",
    action: "upload or delete managed TLS material",
    minimumRole: "admin",
    // `admit_non_config_db_write`: the managed TLS / ACME stores are refused in
    // a read-only mode but are not subject to the config-DB failover gate that
    // `admin_writes_enabled` also folds in.
    gate: "read-only-mode",
  },
  operationalActions: {
    label: "Operational gateway actions",
    headline: "Operational gateway actions are unavailable",
    action: "run operational gateway actions",
    minimumRole: "operator",
    gate: "none",
  },
  bffSettings: {
    label: "BFF connection settings",
    headline: "BFF connection settings are read-only",
    action: "change the Foundry BFF connection settings",
    minimumRole: "admin",
    gate: "none",
  },
};

export const CAPABILITY_SURFACES = Object.keys(SURFACES) as CapabilitySurface[];

export type GatewayWriteState =
  | { state: "enabled" }
  | { state: "read-only"; explanation: string }
  | { state: "unknown" };

function observedMode(facts: CapabilityFacts): string | null {
  return typeof facts.mode === "string" ? facts.mode.trim().toLowerCase() : null;
}

function observedStatus(facts: CapabilityFacts): string | null {
  return typeof facts.status === "string" ? facts.status.trim().toLowerCase() : null;
}

/**
 * Classify only the read-only-mode gate — the one Ferrum Edge applies to every
 * admin mutation, including the independent managed TLS / ACME stores.
 *
 * `unknown` when neither an unconditional read-only mode nor the
 * `FERRUM_ADMIN_READ_ONLY` observation has been read. On `database`/`cp` the
 * mode string cannot reveal that flag; `handle_health` forces `status:
 * "degraded"` only when writes are blocked **and** the process is not
 * read-only, so `admin_writes_enabled === false` together with an observed
 * `status` other than `"degraded"` is a positive observation of admin
 * read-only mode and cannot fire on a failover-topology denial.
 */
export function resolveReadOnlyModeState(facts: CapabilityFacts): GatewayWriteState {
  const mode = observedMode(facts);
  if (mode && READ_ONLY_MODES.has(mode)) {
    return {
      state: "read-only",
      explanation:
        MODE_EXPLANATIONS[mode] ??
        `The gateway runs in ${mode} mode, where the admin API is read-only.`,
    };
  }
  const status = observedStatus(facts);
  if (facts.adminWritesEnabled === false && status && status !== "degraded") {
    return { state: "read-only", explanation: ADMIN_READ_ONLY_FLAG_EXPLANATION };
  }
  return { state: "unknown" };
}

/**
 * Classify whether the gateway will accept configuration-store writes at all.
 * `unknown` is the honest answer whenever neither signal was observed.
 */
export function resolveGatewayWriteState(facts: CapabilityFacts): GatewayWriteState {
  const readOnlyMode = resolveReadOnlyModeState(facts);
  // The mode check runs first because it names a cause the operator can act on.
  if (readOnlyMode.state === "read-only") return readOnlyMode;
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

  if (surface === "configExport" && observedMode(facts) === "node_agent") {
    return {
      allowed: false,
      label,
      headline,
      blockedBy: "gateway-read-only",
      summary: "The gateway has no cached configuration",
      explanation: NODE_AGENT_EXPORT_EXPLANATION,
    };
  }

  if (descriptor.gate !== "none") {
    const writeState =
      descriptor.gate === "config-store"
        ? resolveGatewayWriteState(facts)
        : resolveReadOnlyModeState(facts);
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
