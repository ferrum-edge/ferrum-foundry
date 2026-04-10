/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – shared API types (mirrors the OpenAPI spec)      */
/* ------------------------------------------------------------------ */

// ── Pagination ────────────────────────────────────────────────────

export interface Pagination {
  offset: number;
  limit: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

// ── Proxies ───────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  failure_threshold: number;
  success_threshold: number;
  timeout_seconds: number;
  failure_status_codes: number[];
  half_open_max_requests: number;
  trip_on_connection_errors: boolean;
}

export type BackoffStrategy =
  | { fixed: { delay_ms: number } }
  | { exponential: { base_ms: number; max_ms: number } };

export interface RetryConfig {
  max_retries: number;
  retryable_status_codes: number[];
  retryable_methods: string[];
  backoff: BackoffStrategy;
  retry_on_connect_failure: boolean;
}

export interface PluginAssociation {
  plugin_config_id: string;
}

export interface Proxy {
  id: string;
  name?: string;
  listen_path: string;
  hosts: string[];
  backend_protocol:
    | "http"
    | "https"
    | "ws"
    | "wss"
    | "grpc"
    | "grpcs"
    | "h3"
    | "tcp"
    | "tcp_tls"
    | "udp"
    | "dtls";
  backend_host: string;
  backend_port: number;
  backend_path?: string;
  strip_listen_path: boolean;
  preserve_host_header: boolean;
  backend_connect_timeout_ms: number;
  backend_read_timeout_ms: number;
  backend_write_timeout_ms: number;
  backend_tls_client_cert_path?: string;
  backend_tls_client_key_path?: string;
  backend_tls_verify_server_cert: boolean;
  backend_tls_server_ca_cert_path?: string;
  dns_override?: string;
  dns_cache_ttl_seconds?: number;
  auth_mode: "single" | "multi";
  plugins: PluginAssociation[];
  upstream_id?: string;
  listen_port?: number;
  frontend_tls: boolean;
  passthrough: boolean;
  tcp_idle_timeout_seconds?: number;
  udp_idle_timeout_seconds: number;
  allowed_methods?: (
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
    | "TRACE"
    | "CONNECT"
  )[];
  allowed_ws_origins: string[];
  circuit_breaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  response_body_mode: "stream" | "buffer";
  // Connection pool overrides
  pool_idle_timeout_seconds?: number;
  pool_enable_http_keep_alive?: boolean;
  pool_enable_http2?: boolean;
  pool_tcp_keepalive_seconds?: number;
  pool_http2_keep_alive_interval_seconds?: number;
  pool_http2_keep_alive_timeout_seconds?: number;
  pool_http2_initial_stream_window_size?: number;
  pool_http2_initial_connection_window_size?: number;
  pool_http2_adaptive_window?: boolean;
  pool_http2_max_frame_size?: number;
  pool_http2_max_concurrent_streams?: number;
  pool_http3_connections_per_backend?: number;
  created_at: string;
  updated_at: string;
}

export interface ProxyCreate {
  id?: string;
  listen_path: string;
  backend_protocol: Proxy["backend_protocol"];
  backend_host: string;
  backend_port: number;
  name?: string;
  hosts?: string[];
  backend_path?: string;
  strip_listen_path?: boolean;
  preserve_host_header?: boolean;
  backend_connect_timeout_ms?: number;
  backend_read_timeout_ms?: number;
  backend_write_timeout_ms?: number;
  backend_tls_client_cert_path?: string;
  backend_tls_client_key_path?: string;
  backend_tls_verify_server_cert?: boolean;
  backend_tls_server_ca_cert_path?: string;
  dns_override?: string;
  dns_cache_ttl_seconds?: number;
  auth_mode?: "single" | "multi";
  plugins?: PluginAssociation[];
  upstream_id?: string;
  listen_port?: number;
  frontend_tls?: boolean;
  passthrough?: boolean;
  tcp_idle_timeout_seconds?: number;
  udp_idle_timeout_seconds?: number;
  allowed_methods?: Proxy["allowed_methods"];
  allowed_ws_origins?: string[];
  circuit_breaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  response_body_mode?: "stream" | "buffer";
  pool_idle_timeout_seconds?: number;
  pool_enable_http_keep_alive?: boolean;
  pool_enable_http2?: boolean;
  pool_tcp_keepalive_seconds?: number;
  pool_http2_keep_alive_interval_seconds?: number;
  pool_http2_keep_alive_timeout_seconds?: number;
  pool_http2_initial_stream_window_size?: number;
  pool_http2_initial_connection_window_size?: number;
  pool_http2_adaptive_window?: boolean;
  pool_http2_max_frame_size?: number;
  pool_http2_max_concurrent_streams?: number;
  pool_http3_connections_per_backend?: number;
}

// ── Consumers ─────────────────────────────────────────────────────

export interface Consumer {
  id: string;
  username: string;
  custom_id?: string;
  credentials: Record<string, unknown>;
  acl_groups: string[];
  created_at: string;
  updated_at: string;
}

export interface ConsumerCreate {
  id?: string;
  username: string;
  custom_id?: string;
  credentials?: Record<string, unknown>;
  acl_groups?: string[];
}

// ── Plugins ───────────────────────────────────────────────────────

export interface PluginConfig {
  id: string;
  plugin_name: string;
  config: Record<string, unknown>;
  scope: "global" | "proxy";
  proxy_id?: string;
  enabled: boolean;
  priority_override?: number;
  created_at: string;
  updated_at: string;
}

export interface PluginConfigCreate {
  id?: string;
  plugin_name: string;
  config?: Record<string, unknown>;
  scope: "global" | "proxy";
  proxy_id?: string;
  enabled?: boolean;
  priority_override?: number;
}

// ── Upstreams ─────────────────────────────────────────────────────

export interface UpstreamTarget {
  host: string;
  port: number;
  weight: number;
  tags?: Record<string, string>;
  path?: string;
}

export interface HashOnCookieConfig {
  name: string;
  path?: string;
  ttl_seconds?: number;
}

export interface ActiveHealthCheck {
  enabled: boolean;
  interval_seconds: number;
  timeout_seconds: number;
  healthy_threshold: number;
  unhealthy_threshold: number;
  path: string;
  expected_status_codes: number[];
}

export interface PassiveHealthCheck {
  enabled: boolean;
  unhealthy_threshold: number;
  unhealthy_status_codes: number[];
  healthy_threshold: number;
}

export interface HealthCheckConfig {
  active?: ActiveHealthCheck;
  passive?: PassiveHealthCheck;
}

export interface ServiceDiscoveryConfig {
  provider: string;
  service_name: string;
  refresh_interval_seconds: number;
  config: Record<string, unknown>;
}

export interface Upstream {
  id: string;
  name?: string;
  targets: UpstreamTarget[];
  algorithm:
    | "round_robin"
    | "weighted_round_robin"
    | "least_connections"
    | "least_latency"
    | "consistent_hashing"
    | "random";
  hash_on?: string;
  hash_on_cookie_config?: HashOnCookieConfig;
  health_checks?: HealthCheckConfig;
  service_discovery?: ServiceDiscoveryConfig;
  created_at: string;
  updated_at: string;
}

export interface UpstreamCreate {
  id?: string;
  targets: UpstreamTarget[];
  algorithm: Upstream["algorithm"];
  name?: string;
  hash_on?: string;
  hash_on_cookie_config?: HashOnCookieConfig;
  health_checks?: HealthCheckConfig;
  service_discovery?: ServiceDiscoveryConfig;
}

// ── Health / Metrics ──────────────────────────────────────────────

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  mode: string;
  database: { status: string; type: string; error?: string };
  cached_config: {
    available: boolean;
    loaded_at?: string;
    proxy_count?: number;
    consumer_count?: number;
  };
}

export interface AdminMetrics {
  gateway: {
    mode: string;
    ferrum_version: string;
    uptime_seconds: number;
    requests_per_second_current: number;
    status_codes_last_second: Record<string, number>;
    config_last_updated_at?: string;
    config_source_status: string;
    proxy_count: number;
    consumer_count: number;
    upstream_count: number;
    plugin_config_count: number;
  };
  connection_pools: {
    http: {
      total_pools: number;
      max_idle_per_host: number;
      idle_timeout_seconds: number;
      entries_per_host: Record<string, number>;
    };
    grpc: { total_connections: number };
    http2: { total_connections: number };
    http3: { total_connections: number };
  };
  circuit_breakers: Array<{
    proxy_id: string;
    state: string;
    failure_count: number;
    success_count: number;
  }>;
  health_check: {
    unhealthy_target_count: number;
    unhealthy_targets: Array<{ target: string; since_epoch_ms: number }>;
  };
  load_balancers: {
    active_connections: Record<string, Record<string, number>>;
  };
  caches: {
    router: {
      prefix_cache_entries: number;
      regex_cache_entries: number;
      prefix_eviction_count: number;
      regex_eviction_count: number;
      max_cache_entries: number;
    };
    dns: { cache_entries: number };
  };
  consumer_index: {
    total_consumers: number;
    key_auth_credentials: number;
    basic_auth_credentials: number;
    mtls_credentials: number;
  };
  rate_limiting: { tracked_key_count: number };
}

// ── Errors ────────────────────────────────────────────────────────

export interface ApiError {
  statusCode: number;
  body: string;
  url: string;
}
