/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – gateway operations API                            */
/*  (overload, runtime metrics, charges, cluster, capabilities,       */
/*   audit, batch, backup/restore)                                    */
/* ------------------------------------------------------------------ */

import {
  SILENT_ERRORS,
  onApiError,
  proxyApi,
  scoped,
  type NamespaceScope,
} from "./client";
import type {
  Consumer,
  ConsumerCreate,
  PluginConfig,
  PluginConfigCreate,
  Proxy,
  ProxyCreate,
  Upstream,
  UpstreamCreate,
} from "./types";

/* ---------- Overload ---------- */

export type OverloadLevel = "normal" | "pressure" | "critical";

export interface PressureGauge {
  current: number;
  max: number;
  ratio: number;
}

export interface OverloadSnapshot {
  level: OverloadLevel;
  message?: string;
  draining?: boolean;
  active_connections?: number;
  active_requests?: number;
  red_drop_probability_pct?: number;
  port_exhaustion_events?: number;
  pressure?: {
    file_descriptors?: PressureGauge;
    connections?: PressureGauge;
    requests?: PressureGauge;
    event_loop_latency_us?: number;
  };
  actions?: {
    disable_keepalive: boolean;
    reject_new_connections: boolean;
    reject_new_requests: boolean;
  };
  [extra: string]: unknown;
}

function isOverloadSnapshot(value: unknown): value is OverloadSnapshot {
  if (!value || typeof value !== "object" || !("level" in value)) return false;
  return value.level === "normal" || value.level === "pressure" || value.level === "critical";
}

/** GET /overload returns 503 with the same body at critical level. */
export async function getOverload(
  scope: NamespaceScope,
): Promise<OverloadSnapshot> {
  let response: Response | undefined;
  try {
    // Classify this endpoint's body before reporting an error: its critical
    // snapshot is a successful observation despite the HTTP 503 status.
    response = await proxyApi.get(
      "overload",
      scoped(scope, { throwHttpErrors: false, context: { [SILENT_ERRORS]: true } }),
    );
    const snapshot: unknown = await response.clone().json().catch(() => null);
    if (
      isOverloadSnapshot(snapshot) &&
      (response.ok || (response.status === 503 && snapshot.level === "critical"))
    ) {
      return snapshot;
    }
    throw new Error(`Overload endpoint returned ${response.status} without a valid snapshot`);
  } catch (error) {
    // The shared hook was silent, so report genuine HTTP/body/network errors
    // exactly once here and still reject for the panel's unavailable state.
    onApiError({
      statusCode: response?.status ?? 0,
      body: response
        ? await response.text().catch(() => "")
        : error instanceof Error ? error.message : "Overload request failed",
      url: response?.url || "/api/proxy/overload",
    });
    throw error;
  }
}

/* ---------- Runtime metrics ---------- */

export interface RuntimeMetricsSnapshot {
  timestamp: string;
  uptime_seconds: number;
  mode: string;
  ferrum_version: string;
  system?: {
    sampled_at_unix_ms?: number;
    platform?: string;
    cpu?: {
      process_percent?: number;
      system_percent?: number | null;
      cgroup_quota_percent?: number | null;
      cpu_count?: number;
    };
    memory?: {
      rss_bytes?: number;
      virtual_bytes?: number;
      host_percent?: number | null;
      cgroup_percent?: number | null;
      cgroup_limit_bytes?: number | null;
    };
    file_descriptors?: { current?: number; max?: number; ratio?: number };
    ephemeral_ports?: {
      range_size?: number | null;
      exhaustion_events?: number;
      active_outbound_estimate?: number;
    };
  };
  http?: {
    total_requests?: number;
    requests_per_second_1s?: number;
    requests_per_second_1m?: number;
    requests_per_second_5m?: number;
    client_disconnects?: number;
    status_codes?: {
      totals?: Record<string, number>;
      rate_1m?: Record<string, number>;
      percent_1m?: Record<string, number>;
    };
  };
  errors?: {
    by_class?: Record<
      string,
      { http?: number; grpc?: number; stream?: number; body?: number }
    >;
    by_proxy?: Record<string, Record<string, number>>;
  };
  dns?: {
    lookups_total?: number;
    cache_hits?: number;
    cache_misses?: number;
    stale_serves?: number;
    errors?: number;
    hit_ratio?: number;
    error_ratio?: number;
    cache_entries?: number;
  };
  connections?: {
    active?: number;
    active_requests?: number;
    pool_handshakes_total?: Record<string, number>;
    pool_evictions_total?: Record<string, number>;
    pool_failures_total?: Record<string, number>;
  };
  logs?: {
    by_level?: Record<string, number>;
  };
  overload?: OverloadSnapshot;
  [extra: string]: unknown;
}

export async function getRuntimeMetrics(
  scope: NamespaceScope,
): Promise<RuntimeMetricsSnapshot> {
  return proxyApi
    .get("metrics/runtime", scoped(scope))
    .json<RuntimeMetricsSnapshot>();
}

/* ---------- Chargeback ---------- */

export interface ChargebackProxyEntry {
  proxy_id?: string;
  namespace?: string;
  proxy_name?: string;
  currency?: string;
  protocol_family?: "http" | "stream" | "mixed";
  total_charges?: number;
  total_calls?: number;
  by_status?: Record<string, { calls?: number; charges?: number }>;
  bandwidth?: {
    bytes_sent?: number;
    bytes_received?: number;
    charge_sent?: number;
    charge_received?: number;
  };
  stream?: { connections?: number; connection_charges?: number };
}

export interface ChargebackConsumerEntry {
  total_charges?: number | null;
  total_calls?: number;
  per_call_charges?: number | null;
  stream_connection_charges?: number | null;
  bandwidth_charges?: number | null;
  charges_by_currency?: Record<
    string,
    { total_calls?: number; total_charges?: number }
  >;
  proxies?: Record<string, ChargebackProxyEntry>;
}

export interface ChargebackResponse {
  currency?: string;
  generated_at?: string;
  registry?: {
    entries?: number;
    max_entries?: number;
    retained_bytes?: number;
    max_retained_bytes?: number;
    dropped_charges_total?: number;
  };
  consumers?: Record<string, ChargebackConsumerEntry>;
}

export async function getCharges(
  scope: NamespaceScope,
): Promise<ChargebackResponse> {
  return proxyApi
    .get("charges", scoped(scope, { searchParams: { format: "json" } }))
    .json<ChargebackResponse>();
}

export interface ChargebackSinkStatusResponse {
  enabled: boolean;
  instance_count: number;
  snapshot_finalizations_pending: number;
  totals: {
    queue: { depth?: number; capacity?: number; full_drops_total?: number };
    spool: { files?: number; bytes?: number; drops_total?: number; available?: boolean };
    export: {
      events_enqueued_total?: number;
      events_exported_total?: number;
      failures_total?: number;
    };
  };
  instances: Array<{
    plugin_config_id: string;
    mode: "per_event" | "snapshot";
    clickhouse: { endpoint?: string; database?: string; table?: string };
    queue: { depth?: number; capacity?: number };
    export: {
      events_exported_total?: number;
      failures_total?: number;
      last_success_at?: string | null;
      last_failure_at?: string | null;
      last_failure_reason?: string | null;
    };
    [extra: string]: unknown;
  }>;
}

export async function getChargesSinkStatus(
  scope: NamespaceScope,
): Promise<ChargebackSinkStatusResponse> {
  return proxyApi
    .get("charges/sink/status", scoped(scope))
    .json<ChargebackSinkStatusResponse>();
}

/* ---------- Cluster ---------- */

export interface ConnectedDpNode {
  node_id: string;
  version: string;
  namespace: string;
  status: "online";
  connected_at: string;
  last_sync_at: string;
}

export interface ClusterStatusCp {
  mode: "cp";
  connected_data_planes: number;
  data_planes: ConnectedDpNode[];
  connected_mesh_nodes: number;
  mesh_nodes: ConnectedDpNode[];
}

export interface ClusterStatusDp {
  mode: "dp";
  control_plane: {
    url: string;
    status: "online" | "offline";
    is_primary: boolean;
    connected_since?: string | null;
    last_config_received_at?: string | null;
    config_diverged: boolean;
    config_diverged_since?: string | null;
    config_divergence_recoveries_total: number;
  };
}

export interface ClusterStatusOther {
  mode: string;
  message: string;
}

export type ClusterStatus = ClusterStatusCp | ClusterStatusDp | ClusterStatusOther;

// `ClusterStatusOther.mode: string` swallows the "cp"/"dp" literals during
// narrowing, so use explicit guards instead of switch discrimination.
export function isCpStatus(status: ClusterStatus): status is ClusterStatusCp {
  return status.mode === "cp";
}

export function isDpStatus(status: ClusterStatus): status is ClusterStatusDp {
  return status.mode === "dp";
}

export async function getClusterStatus(
  scope: NamespaceScope,
): Promise<ClusterStatus> {
  return proxyApi.get("cluster", scoped(scope)).json<ClusterStatus>();
}

/* ---------- Backend capabilities ---------- */

export type ProtocolSupport = "unknown" | "supported" | "unsupported";

export interface BackendCapabilityEntry {
  key: string;
  plain_http: { h1: ProtocolSupport; h2_tls: ProtocolSupport; h3: ProtocolSupport };
  grpc_transport: { h2_tls: ProtocolSupport; h2c: ProtocolSupport };
  hbone: ProtocolSupport;
  last_probe_at_unix_secs: number;
  last_probe_error?: string | null;
}

export interface BackendCapabilitiesResponse {
  entries: BackendCapabilityEntry[];
}

export async function getBackendCapabilities(
  scope: NamespaceScope,
): Promise<BackendCapabilitiesResponse> {
  return proxyApi
    .get("backend-capabilities", scoped(scope))
    .json<BackendCapabilitiesResponse>();
}

export async function refreshBackendCapabilities(
  scope: NamespaceScope,
): Promise<{ status: string }> {
  return proxyApi
    .post("backend-capabilities/refresh", scoped(scope))
    .json<{ status: string }>();
}

/* ---------- Audit ---------- */

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  namespace: string;
  source_address?: string;
  request_id?: string;
  outcome?:
    | "success"
    | "failure"
    | "denied"
    | "validation_failed"
    | "unavailable"
    | "unknown_outcome";
  diff: Record<string, unknown>;
}

export interface AuditEventListResponse {
  items: AuditEvent[];
  limit: number;
  offset: number;
  next_offset: number | null;
  total: number;
}

export interface AuditListParams {
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditEvents(
  scope: NamespaceScope,
  params: AuditListParams = {},
): Promise<AuditEventListResponse> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams[key] = String(value);
  }
  return proxyApi
    .get("audit", scoped(scope, { searchParams }))
    .json<AuditEventListResponse>();
}

/* ---------- Batch / backup / restore ---------- */

export interface BatchCreateRequest {
  proxies?: ProxyCreate[];
  consumers?: ConsumerCreate[];
  plugin_configs?: PluginConfigCreate[];
  upstreams?: UpstreamCreate[];
}

export interface BatchCreateResponse {
  created: {
    proxies: number;
    consumers: number;
    plugin_configs: number;
    upstreams: number;
  };
}

export async function batchCreate(
  scope: NamespaceScope,
  data: BatchCreateRequest,
): Promise<BatchCreateResponse> {
  return proxyApi
    .post("batch", scoped(scope, { json: data }))
    .json<BatchCreateResponse>();
}

export interface BackupResponse {
  version: string;
  ferrum_version: string;
  exported_at: string;
  source: "database" | "cached";
  counts: {
    proxies: number;
    consumers: number;
    plugin_configs: number;
    upstreams: number;
    api_specs?: number;
    gateway_trust_bundles?: number;
  };
  proxies: Proxy[];
  consumers: Consumer[];
  plugin_configs: PluginConfig[];
  upstreams: Upstream[];
  gateway_trust_bundles?: unknown[];
  api_specs?: unknown;
}

export async function getBackup(
  scope: NamespaceScope,
  resources?: string[],
): Promise<BackupResponse> {
  const searchParams: Record<string, string> = {};
  if (resources && resources.length > 0) {
    searchParams.resources = resources.join(",");
  }
  return proxyApi
    .get("backup", scoped(scope, { searchParams, timeout: 120_000, retry: 0 }))
    .json<BackupResponse>();
}

export interface RestoreResponse {
  restored: {
    proxies: number;
    consumers: number;
    plugin_configs: number;
    upstreams: number;
    api_specs?: number;
    gateway_trust_bundles?: number;
  };
}

export interface RestoreApiSpecConfirmationRequired {
  error: string;
  api_specs_at_risk: number;
  confirmation_required: "confirm_api_spec_deletion=true";
}

/** Recognize the gateway's canonical destructive-restore conflict fields. */
export function getRestoreApiSpecConfirmation(
  error: unknown,
): RestoreApiSpecConfirmationRequired | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    response?: { status?: unknown };
    data?: unknown;
  };
  if (candidate.response?.status !== 409) return null;
  if (!candidate.data || typeof candidate.data !== "object") return null;
  const body = candidate.data as Record<string, unknown>;
  if (
    typeof body.error !== "string" ||
    !Number.isSafeInteger(body.api_specs_at_risk) ||
    (body.api_specs_at_risk as number) < 0 ||
    body.confirmation_required !== "confirm_api_spec_deletion=true"
  ) {
    return null;
  }
  return {
    error: body.error,
    api_specs_at_risk: body.api_specs_at_risk as number,
    confirmation_required: body.confirmation_required,
  };
}

export type RestoreRollbackOutcome =
  | "completed"
  | "incomplete"
  | "not_needed"
  | "unknown_outcome";

export interface RestoreFailure {
  error: string;
  restore_errors?: string[];
  rollback?: RestoreRollbackOutcome;
  failure_class?: "data_integrity";
  rollback_errors?: string[];
  api_specs_not_restored?: number;
  api_specs_note?: string;
}

const RESTORE_ROLLBACK_OUTCOMES = new Set<RestoreRollbackOutcome>([
  "completed",
  "incomplete",
  "not_needed",
  "unknown_outcome",
]);

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

/** Preserve the gateway's authoritative rollback outcome from a restore 500. */
export function getRestoreFailure(error: unknown): RestoreFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { response?: { status?: unknown }; data?: unknown };
  if (candidate.response?.status !== 500 || !candidate.data || typeof candidate.data !== "object") {
    return null;
  }
  const body = candidate.data as Record<string, unknown>;
  if (typeof body.error !== "string") return null;

  const restoreErrors = optionalStringArray(body, "restore_errors");
  const rollbackErrors = optionalStringArray(body, "rollback_errors");
  if (restoreErrors === null || rollbackErrors === null) return null;
  if (
    body.rollback !== undefined &&
    (typeof body.rollback !== "string" || !RESTORE_ROLLBACK_OUTCOMES.has(body.rollback as RestoreRollbackOutcome))
  ) return null;
  if (body.failure_class !== undefined && body.failure_class !== "data_integrity") return null;
  if (
    body.api_specs_not_restored !== undefined &&
    (!Number.isSafeInteger(body.api_specs_not_restored) || (body.api_specs_not_restored as number) < 0)
  ) return null;
  if (body.api_specs_note !== undefined && typeof body.api_specs_note !== "string") return null;

  return {
    error: body.error,
    ...(restoreErrors !== undefined && { restore_errors: restoreErrors }),
    ...(body.rollback !== undefined && { rollback: body.rollback as RestoreRollbackOutcome }),
    ...(body.failure_class === "data_integrity" && { failure_class: body.failure_class }),
    ...(rollbackErrors !== undefined && { rollback_errors: rollbackErrors }),
    ...(body.api_specs_not_restored !== undefined && {
      api_specs_not_restored: body.api_specs_not_restored as number,
    }),
    ...(body.api_specs_note !== undefined && { api_specs_note: body.api_specs_note }),
  };
}

/**
 * Restore replaces the whole of `scope.namespace`. The scope is the one the
 * user confirmed in the restore dialog, captured when the dialog opened, so
 * a later switch cannot redirect the replacement.
 */
export async function restore(
  scope: NamespaceScope,
  data: Record<string, unknown>,
  options: { confirmApiSpecDeletion?: boolean } = {},
): Promise<RestoreResponse> {
  const searchParams: Record<string, string> = { confirm: "true" };
  if (options.confirmApiSpecDeletion) {
    searchParams.confirm_api_spec_deletion = "true";
  }
  return proxyApi
    .post(
      "restore",
      scoped(scope, {
        json: data,
        searchParams,
        timeout: 120000,
        context: { [SILENT_ERRORS]: true },
      }),
    )
    .json<RestoreResponse>();
}
