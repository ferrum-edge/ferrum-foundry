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

/**
 * Wire-level scheme a proxy uses to talk to its backend. gRPC and
 * WebSocket are detected per-request and are no longer schemes;
 * `tcps` replaces the legacy `tcp_tls` spelling.
 */
export type BackendScheme = "http" | "https" | "tcp" | "tcps" | "udp" | "dtls";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "TRACE"
  | "CONNECT";

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

export type AuthMode = "single" | "multi";

/** Bounded L4 connection matcher arm for TCP/TCP+TLS proxies. */
export interface StreamMatchArm {
  source_labels?: Record<string, string>;
  source_namespace?: string;
  source_subnets?: string[];
  destination_subnets?: string[];
  gateways?: string[];
}

export interface StreamMatchCriteria {
  arms?: StreamMatchArm[];
}

export interface Proxy {
  id: string;
  namespace?: string;
  name?: string | null;
  listen_path?: string | null;
  hosts: string[];
  backend_scheme?: BackendScheme | null;
  backend_host: string;
  backend_port: number;
  backend_path?: string | null;
  strip_listen_path: boolean;
  preserve_host_header: boolean;
  backend_connect_timeout_ms: number;
  backend_read_timeout_ms: number;
  backend_write_timeout_ms: number;
  backend_tls_client_cert_path?: string | null;
  backend_tls_client_key_path?: string | null;
  backend_tls_verify_server_cert: boolean;
  backend_tls_server_ca_cert_path?: string | null;
  dns_override?: string | null;
  dns_cache_ttl_seconds?: number | null;
  auth_mode: AuthMode;
  plugins: PluginAssociation[];
  upstream_id?: string | null;
  upstream_subset?: string | null;
  listen_port?: number | null;
  frontend_tls: boolean;
  passthrough: boolean;
  stream_proxy_protocol?: boolean | null;
  backend_proxy_protocol?: "v2" | null;
  stream_match?: StreamMatchCriteria | null;
  tcp_idle_timeout_seconds?: number | null;
  websocket_idle_timeout_seconds?: number | null;
  udp_idle_timeout_seconds: number;
  udp_max_response_amplification_factor?: number | null;
  allowed_methods?: HttpMethod[] | null;
  allowed_ws_origins: string[];
  circuit_breaker?: CircuitBreakerConfig | null;
  retry?: RetryConfig | null;
  response_body_mode: "stream" | "buffer";
  // Connection pool overrides
  pool_idle_timeout_seconds?: number | null;
  pool_enable_http_keep_alive?: boolean | null;
  pool_enable_http2?: boolean | null;
  pool_tcp_keepalive_seconds?: number | null;
  pool_http2_keep_alive_interval_seconds?: number | null;
  pool_http2_keep_alive_timeout_seconds?: number | null;
  pool_http2_initial_stream_window_size?: number | null;
  pool_http2_initial_connection_window_size?: number | null;
  pool_http2_adaptive_window?: boolean | null;
  pool_http2_max_frame_size?: number | null;
  pool_http2_max_concurrent_streams?: number | null;
  pool_http3_connections_per_backend?: number | null;
  pool_max_requests_per_connection?: number | null;
  api_spec_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type ProxyCreate = Partial<Omit<Proxy, "created_at" | "updated_at">> & {
  backend_host: string;
  backend_port: number;
};

// ── Consumers ─────────────────────────────────────────────────────

/** Reserved placeholder returned in place of stored secrets. */
export const REDACTED = "[REDACTED]";

export type BuiltInCredentialType =
  | "keyauth"
  | "basicauth"
  | "jwt"
  | "hmac_auth"
  | "mtls_auth";

export interface KeyAuthCredential {
  key: string;
}

export interface BasicAuthCredential {
  password?: string;
  password_hash?: string;
}

export interface JwtCredential {
  secret: string;
}

export interface HmacAuthCredential {
  secret: string;
}

export interface MtlsAuthCredential {
  identity: string;
}

/**
 * Credential map. Each built-in type maps to a rotation array. In
 * ordinary responses `basicauth` is omitted and secret fields carry
 * the `[REDACTED]` placeholder; a PUT may echo the placeholder back
 * to preserve the stored entry at the same index.
 */
export interface ConsumerCredentials {
  keyauth?: KeyAuthCredential[];
  basicauth?: BasicAuthCredential[];
  jwt?: JwtCredential[];
  hmac_auth?: HmacAuthCredential[];
  mtls_auth?: MtlsAuthCredential[];
  [custom: string]: object[] | undefined;
}

export interface Consumer {
  id: string;
  namespace?: string;
  username: string;
  custom_id?: string | null;
  credentials: ConsumerCredentials;
  acl_groups: string[];
  created_at: string;
  updated_at: string;
}

export interface ConsumerCreate {
  id?: string;
  username: string;
  custom_id?: string | null;
  credentials?: ConsumerCredentials;
  acl_groups?: string[];
}

/** Single credential entry accepted by the credential mutation endpoints. */
export type ConsumerCredentialInput =
  | KeyAuthCredential
  | BasicAuthCredential
  | JwtCredential
  | HmacAuthCredential
  | MtlsAuthCredential;

// ── Plugins ───────────────────────────────────────────────────────

export type PluginScope = "global" | "proxy" | "proxy_group";

export type PluginTriggerProtocol =
  | "http1"
  | "http2"
  | "http3"
  | "grpc"
  | "grpc_web"
  | "websocket"
  | "tcp"
  | "udp"
  | "dtls";

export interface PluginTriggerStringMatch {
  exact?: string[];
  prefix?: string[];
  regex?: string;
  case_insensitive?: boolean;
}

export interface PluginTriggerFieldMatch {
  name: string;
  presence?: "present" | "absent";
  value?: PluginTriggerStringMatch;
  multi_value?: "any" | "all";
}

export interface PluginTriggerIdentityMatch {
  presence?: "present" | "absent";
  value?: PluginTriggerStringMatch;
}

export interface PluginTriggerMatch {
  method?: string[];
  path?: PluginTriggerStringMatch;
  host?: PluginTriggerStringMatch;
  sni?: PluginTriggerStringMatch;
  header?: PluginTriggerFieldMatch;
  query?: PluginTriggerFieldMatch;
  cookie?: PluginTriggerFieldMatch;
  protocol?: PluginTriggerProtocol[];
  source_cidr?: string[];
  namespace?: string[];
  proxy_id?: string[];
  listen_port?: number[];
  consumer?: PluginTriggerIdentityMatch;
  auth_method?: string[];
  spiffe_id?: PluginTriggerIdentityMatch;
}

export interface PluginTriggerNode {
  all?: PluginTriggerNode[];
  any?: PluginTriggerNode[];
  not?: PluginTriggerNode;
  match?: PluginTriggerMatch;
}

/** Declarative per-instance plugin execution trigger. */
export interface PluginTrigger {
  when: PluginTriggerNode;
}

export interface PluginConfig {
  id: string;
  namespace?: string;
  plugin_name: string;
  config: Record<string, unknown>;
  scope: PluginScope;
  proxy_id?: string | null;
  enabled: boolean;
  priority_override?: number | null;
  trigger?: PluginTrigger | null;
  api_spec_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PluginConfigCreate {
  id?: string;
  plugin_name: string;
  config?: Record<string, unknown>;
  scope: PluginScope;
  proxy_id?: string | null;
  enabled?: boolean;
  priority_override?: number | null;
  trigger?: PluginTrigger | null;
}

// ── Upstreams ─────────────────────────────────────────────────────

export type LoadBalancerAlgorithm =
  | "round_robin"
  | "weighted_round_robin"
  | "least_connections"
  | "least_latency"
  | "consistent_hashing"
  | "random"
  | "passthrough";

export interface UpstreamTarget {
  host: string;
  port: number;
  weight?: number;
  tags?: Record<string, string>;
  locality?: string | null;
  path?: string | null;
}

export interface SubsetTrafficPolicy {
  load_balancer_algorithm?: LoadBalancerAlgorithm | null;
  hash_on?: string | null;
}

export interface SubsetDefinition {
  name: string;
  labels: Record<string, string>;
  traffic_policy?: SubsetTrafficPolicy | null;
}

export interface HashOnCookieConfig {
  path?: string;
  ttl_seconds?: number;
  session_cookie?: boolean;
  domain?: string | null;
  http_only?: boolean;
  secure?: boolean;
  same_site?: "Strict" | "Lax" | "None" | null;
}

export interface ActiveHealthCheck {
  http_path?: string;
  interval_seconds?: number;
  timeout_ms?: number;
  healthy_threshold?: number;
  unhealthy_threshold?: number;
  healthy_status_codes?: number[];
  probe_type?: "http" | "tcp" | "udp" | "grpc";
  udp_probe_payload?: string | null;
  grpc_service_name?: string | null;
  use_tls?: boolean;
}

export interface PassiveHealthCheck {
  unhealthy_status_codes?: number[];
  unhealthy_threshold?: number;
  unhealthy_window_seconds?: number;
  healthy_after_seconds?: number;
  max_ejection_percent?: number | null;
}

export interface HealthCheckConfig {
  active?: ActiveHealthCheck | null;
  passive?: PassiveHealthCheck | null;
}

export type ServiceDiscoveryProvider = "dns_sd" | "kubernetes" | "consul" | "mesh";

export interface ServiceDiscoveryConfig {
  provider: ServiceDiscoveryProvider;
  dns_sd?: {
    service_name: string;
    poll_interval_seconds?: number;
  } | null;
  kubernetes?: {
    service_name: string;
    namespace?: string;
    port_name?: string | null;
    label_selector?: string | null;
    poll_interval_seconds?: number;
  } | null;
  consul?: {
    address: string;
    service_name: string;
    datacenter?: string | null;
    tag?: string | null;
    healthy_only?: boolean;
    token?: string | null;
    poll_interval_seconds?: number;
  } | null;
  mesh?: {
    service_name: string;
    namespace?: string | null;
    port?: number | null;
    poll_interval_seconds?: number;
    topology?: "ambient" | "sidecar";
  } | null;
  default_weight?: number;
  max_stale_seconds?: number | null;
  stale_policy?: "retain" | "withdraw" | "fail_readiness" | null;
}

export interface Upstream {
  id: string;
  namespace?: string;
  name?: string | null;
  targets: UpstreamTarget[];
  algorithm: LoadBalancerAlgorithm;
  hash_on?: string | null;
  hash_on_cookie_config?: HashOnCookieConfig | null;
  health_checks?: HealthCheckConfig | null;
  service_discovery?: ServiceDiscoveryConfig | null;
  subsets?: SubsetDefinition[] | null;
  // Read-only mesh-projected fields
  port_overrides?: Record<string, unknown>;
  source_locality?: string | null;
  source_labels?: Record<string, string>;
  locality_lb_setting?: Record<string, unknown> | null;
  locality_lb_strict?: boolean;
  // Backend TLS (takes precedence over the referencing proxy's TLS fields)
  backend_tls_client_cert_path?: string | null;
  backend_tls_client_key_path?: string | null;
  backend_tls_verify_server_cert?: boolean;
  backend_tls_server_ca_cert_path?: string | null;
  backend_tls_sni?: string | null;
  backend_tls_san_allow_list?: string[];
  api_spec_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type UpstreamCreate = Partial<
  Omit<
    Upstream,
    | "created_at"
    | "updated_at"
    | "port_overrides"
    | "source_locality"
    | "source_labels"
    | "locality_lb_setting"
    | "locality_lb_strict"
    | "api_spec_id"
  >
> & {
  targets: UpstreamTarget[];
};

// ── Health / Metrics ──────────────────────────────────────────────

export interface HealthResponse {
  status: "ok" | "degraded" | "starting" | "unavailable";
  ready: boolean;
  // Authenticated-tier detail fields
  admin_writes_enabled?: boolean;
  timestamp?: string;
  mode?: string;
  database?: {
    status: "connected" | "disconnected";
    type?: string;
    error?: string | null;
    pool?: {
      size?: number;
      idle?: number;
      active?: number;
      max_connections?: number;
      min_connections?: number;
    };
  };
  fips?: {
    mode: "off" | "enforce";
    enforcing: boolean;
    build_capable: boolean;
    build_profile: string;
    provider: string;
    module_self_test_passed: boolean;
    provider_algorithms_approved: boolean;
  };
  cached_config?: {
    available: boolean;
    loaded_at?: string;
    proxy_count?: number;
    consumer_count?: number;
  };
  config_rejected?: boolean;
  // The health payload carries many optional mode-specific snapshot
  // sections (mesh, service discovery, logging sinks, listeners, ...).
  [snapshot: string]: unknown;
}

export interface AdminMetricsCircuitBreaker {
  namespace: string;
  proxy_id: string;
  target?: string;
  state: "closed" | "open" | "half_open";
  failure_count: number;
  success_count: number;
}

export interface AdminMetricsUnhealthyTarget {
  namespace: string;
  proxy_id?: string;
  upstream_id?: string;
  target: string;
  type: "active" | "passive";
  since_epoch_ms: number;
}

export interface AdminMetricsUpstreamConnections {
  namespace: string;
  upstream_id: string;
  targets: Record<string, number>;
}

export interface AdminMetrics {
  gateway: {
    mode: string;
    ferrum_version: string;
    uptime_seconds: number;
    total_requests: number;
    requests_per_second: number;
    status_codes_total: Record<string, number>;
    status_codes_per_second: Record<string, number>;
    metrics_window_seconds?: number;
    config_last_updated_at?: string | null;
    config_source_status: "online" | "offline" | "n/a";
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
  circuit_breakers: AdminMetricsCircuitBreaker[];
  health_check: {
    unhealthy_target_count: number;
    unhealthy_targets: AdminMetricsUnhealthyTarget[];
  };
  load_balancers: {
    active_connections: AdminMetricsUpstreamConnections[];
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
    jwt_credentials: number;
    hmac_credentials: number;
    identity_credentials: number;
  };
  rate_limiting: { tracked_key_count: number };
  tcp_connection_throttle?: {
    enforcement_scope: string;
    replica_limit_behavior: string;
  };
  database_polling?: Record<string, unknown>;
}

// ── Errors ────────────────────────────────────────────────────────

export interface ApiError {
  statusCode: number;
  body: string;
  url: string;
}
