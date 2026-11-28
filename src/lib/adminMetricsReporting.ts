/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – which /admin/metrics values a gateway reports     */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "../api/types";

/**
 * What one `/admin/metrics` response actually measures, decided from its
 * `gateway.mode`. The Metrics page and the Dashboard both read it, so the two
 * surfaces cannot disagree about a value.
 *
 * Ferrum Edge builds a control plane (`cp`) and a node agent (`node_agent`)
 * without proxy state. Their response is a skeleton (`empty_proxy_metrics` in
 * Edge's `src/admin/metrics.rs`, documented in `docs/admin_metrics.md`):
 * uptime, request totals and rates, the metrics window, every resource count
 * and every proxy-backed panel (circuit breakers, health checks, load
 * balancers, pools, caches, consumer index, rate limiting) are zero or empty
 * placeholders, and `config_last_updated_at` is `null`. Only `mode`,
 * `ferrum_version` and `config_source_status` (`online`/`offline` on a control
 * plane, `n/a` on a node agent) describe the process. Every other mode
 * (`database`, `file`, `dp`, `mesh`) serves the full proxy-backed payload, so
 * a zero there is a measured zero and must stay visible.
 */
export interface AdminMetricsReporting {
  /** The raw `gateway.mode`. */
  mode: string;
  /** Readable mode name, e.g. "Control plane". The raw mode when unknown. */
  modeLabel: string;
  /**
   * Whether the proxy-runtime values are measurements: uptime, request totals
   * and rates, status codes, resource counts, the config snapshot time, and
   * the circuit breaker, health check, load balancer, pool, cache, consumer
   * index and rate limiting panels. When false they are placeholders and must
   * not be shown as values.
   */
  reportsProxyRuntime: boolean;
  /**
   * Short label shown in place of a value this process does not report, e.g.
   * "Not reported by a control plane". Set only when `reportsProxyRuntime` is
   * false.
   */
  unavailableLabel?: string;
  /** One sentence explaining why, for a notice. Set with `unavailableLabel`. */
  unavailableDetail?: string;
}

/**
 * Where the mode facts below were read. `npm run check:edge-source-parity`
 * (`scripts/edge-source-parity.mjs`) re-reads `path` at `edge.source_commit`
 * in the Pinned Gateway Contract job, and at Edge `main` in the Edge Main
 * Drift workflow: `ADMIN_METRICS_MODES` must be the modes `MODE_LABELS` names,
 * and the modes `contract_fixtures` does not give a proxy-serving payload
 * (Edge's own record of which modes answer with `empty_proxy_metrics`) must
 * be `NO_PROXY_STATE_MODES`. The Gateway Modes job checks the same decision
 * against a real control plane's `/admin/metrics`.
 */
export const ADMIN_METRICS_SOURCE = {
  repository: "ferrum-edge/ferrum-edge",
  path: "src/admin/metrics.rs",
  release: "v0.9.21",
  commit: "f9915358c8032214f4034a17c28cdf72d14006c3",
} as const;

// Maps, not object literals: a mode string such as "constructor" must not
// resolve to an inherited Object.prototype member.
const MODE_LABELS: ReadonlyMap<string, string> = new Map([
  ["database", "Database"],
  ["file", "File"],
  ["cp", "Control plane"],
  ["dp", "Data plane"],
  ["mesh", "Mesh"],
  ["node_agent", "Node agent"],
]);

/** Modes whose AdminState has no proxy state, by the role named in labels. */
const NO_PROXY_STATE_ROLES: ReadonlyMap<string, string> = new Map([
  ["cp", "a control plane"],
  ["node_agent", "a node agent"],
]);

/** Every `gateway.mode` Foundry names. */
export const METRICS_MODES: readonly string[] = [...MODE_LABELS.keys()];

/** The modes whose `/admin/metrics` is Edge's no-proxy-state skeleton. */
export const NO_PROXY_STATE_MODES: readonly string[] = [...NO_PROXY_STATE_ROLES.keys()];

export function adminMetricsReporting(mode: string): AdminMetricsReporting {
  const modeLabel = MODE_LABELS.get(mode) ?? mode;
  const role = NO_PROXY_STATE_ROLES.get(mode);
  if (role === undefined) return { mode, modeLabel, reportsProxyRuntime: true };
  return {
    mode,
    modeLabel,
    reportsProxyRuntime: false,
    unavailableLabel: `Not reported by ${role}`,
    unavailableDetail:
      `${role.charAt(0).toUpperCase()}${role.slice(1)} holds no proxy state. ` +
      "Ferrum Edge zeroes its uptime, request traffic, resource counts and " +
      "proxy runtime panels, so Foundry does not show those placeholders as values.",
  };
}

const CONFIG_SOURCE_LABELS: ReadonlyMap<string, string> = new Map([
  ["online", "Online"],
  ["offline", "Offline"],
  ["n/a", "Not applicable"],
]);

/** Readable `config_source_status`; reported in every mode. */
export function configSourceLabel(status: AdminMetrics["gateway"]["config_source_status"]): string {
  return CONFIG_SOURCE_LABELS.get(status) ?? status;
}
