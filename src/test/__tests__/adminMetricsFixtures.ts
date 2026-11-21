import type { AdminMetrics } from "@/api/types";

/**
 * A canonical `/admin/metrics` response for `mode`. For `cp` and `node_agent`
 * it is Edge's `empty_proxy_metrics` skeleton (no proxy state): zeroed
 * counters, empty pools and caches, a `null` config snapshot time, and a
 * config source of `online` (CP) or `n/a` (node agent). Every other mode gets
 * a proxy-backed response whose counters are genuine measured zeros.
 */
export function adminMetricsSnapshot(mode: string): AdminMetrics {
  const skeleton = mode === "cp" || mode === "node_agent";
  return {
    gateway: {
      mode, ferrum_version: "0.9.20", uptime_seconds: skeleton ? 0 : 10, total_requests: 0,
      requests_per_second: 0, status_codes_total: {}, status_codes_per_second: {},
      metrics_window_seconds: skeleton ? 0 : 30,
      config_last_updated_at: skeleton ? null : "2026-11-20T12:00:00Z",
      config_source_status: ["database", "cp"].includes(mode) ? "online" : "n/a",
      proxy_count: 0, consumer_count: 0,
      upstream_count: 0, plugin_config_count: 0,
    },
    connection_pools: skeleton ? {} : { grpc: { total_connections: 0 } },
    caches: skeleton ? {} : { dns: { cache_entries: 0 } },
    circuit_breakers: [],
    health_check: { unhealthy_target_count: 0, unhealthy_targets: [] },
    load_balancers: { active_connections: [] },
    consumer_index: {
      total_consumers: 0, key_auth_credentials: 0, basic_auth_credentials: 0,
      mtls_credentials: 0, jwt_credentials: 0, hmac_credentials: 0, identity_credentials: 0,
    },
    rate_limiting: { tracked_key_count: 0 },
  };
}
