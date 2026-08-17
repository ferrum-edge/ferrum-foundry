/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – gateway operations API                            */
/*  (overload, runtime metrics, charges, cluster, capabilities,       */
/*   audit, batch, backup/restore)                                    */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
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

/** GET /overload returns 503 with the same body at critical level. */
export async function getOverload(): Promise<OverloadSnapshot> {
  const response = await proxyApi.get("overload", { throwHttpErrors: false });
  if (response.status === 503 || response.ok) {
    return response.json<OverloadSnapshot>();
  }
  throw new Error(`Overload endpoint returned ${response.status}`);
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

export async function getRuntimeMetrics(): Promise<RuntimeMetricsSnapshot> {
  return proxyApi.get("metrics/runtime").json<RuntimeMetricsSnapshot>();
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

export async function getCharges(): Promise<ChargebackResponse> {
  return proxyApi
    .get("charges", { searchParams: { format: "json" } })
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

export async function getChargesSinkStatus(): Promise<ChargebackSinkStatusResponse> {
  return proxyApi.get("charges/sink/status").json<ChargebackSinkStatusResponse>();
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

export async function getClusterStatus(): Promise<ClusterStatus> {
  return proxyApi.get("cluster").json<ClusterStatus>();
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

export async function getBackendCapabilities(): Promise<BackendCapabilitiesResponse> {
  return proxyApi.get("backend-capabilities").json<BackendCapabilitiesResponse>();
}

export async function refreshBackendCapabilities(): Promise<{ status: string }> {
  return proxyApi.post("backend-capabilities/refresh").json<{ status: string }>();
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
  params: AuditListParams = {},
): Promise<AuditEventListResponse> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams[key] = String(value);
  }
  return proxyApi
    .get("audit", { searchParams })
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
  data: BatchCreateRequest,
): Promise<BatchCreateResponse> {
  return proxyApi.post("batch", { json: data }).json<BatchCreateResponse>();
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

export async function getBackup(resources?: string[]): Promise<BackupResponse> {
  const searchParams: Record<string, string> = {};
  if (resources && resources.length > 0) {
    searchParams.resources = resources.join(",");
  }
  return proxyApi.get("backup", { searchParams }).json<BackupResponse>();
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

export async function restore(
  data: Record<string, unknown>,
  options: { confirmApiSpecDeletion?: boolean } = {},
): Promise<RestoreResponse> {
  const searchParams: Record<string, string> = { confirm: "true" };
  if (options.confirmApiSpecDeletion) {
    searchParams.confirm_api_spec_deletion = "true";
  }
  return proxyApi
    .post("restore", { json: data, searchParams, timeout: 120000 })
    .json<RestoreResponse>();
}
