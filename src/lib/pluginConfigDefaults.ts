type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PluginConfigDefault = { [key: string]: JsonValue };

/* ------------------------------------------------------------------ */
/*  Plugin metadata: category + one-line description                  */
/* ------------------------------------------------------------------ */

export type PluginCategory =
  | "Authentication"
  | "Security"
  | "Traffic Control"
  | "Transformations"
  | "Observability"
  | "AI Gateway"
  | "Mesh"
  | "Streaming & Protocols"
  | "Billing"
  | "Testing"
  | "Other";

export interface PluginMeta {
  category: PluginCategory;
  description: string;
}

export const PLUGIN_METADATA: Record<string, PluginMeta> = {
  /* ── Authentication ── */
  key_auth: { category: "Authentication", description: "API key authentication via header or query parameter." },
  basic_auth: { category: "Authentication", description: "HTTP Basic authentication against consumer credentials." },
  jwt_auth: { category: "Authentication", description: "HS256 JWT verification against per-consumer secrets." },
  jwks_auth: { category: "Authentication", description: "JWT verification against remote JWKS providers (RSA/EC)." },
  oauth2_introspection: { category: "Authentication", description: "RFC 7662 bearer token introspection against OAuth2 providers." },
  oidc_relying_party: { category: "Authentication", description: "Browser OIDC login (authorization code + PKCE) with encrypted session cookies." },
  ldap_auth: { category: "Authentication", description: "LDAP bind authentication for consumers." },
  hmac_auth: { category: "Authentication", description: "HMAC request signature verification." },
  mtls_auth: { category: "Authentication", description: "Client certificate (mTLS) identity authentication." },
  soap_ws_security: { category: "Authentication", description: "WS-Security for SOAP: timestamps, UsernameToken, X.509, SAML." },
  spiffe_identity: { category: "Authentication", description: "Extracts the peer SPIFFE ID from the client certificate URI SAN." },

  /* ── Security ── */
  access_control: { category: "Security", description: "Allow/deny by consumer ACL group membership." },
  ip_restriction: { category: "Security", description: "Allow/deny client IPs and CIDR ranges." },
  geo_restriction: { category: "Security", description: "Country-level access control via GeoIP database." },
  bot_detection: { category: "Security", description: "Blocks known bad user agents and scanners." },
  waf: { category: "Security", description: "Web application firewall with OWASP-style rule packs and anomaly scoring." },
  opa: { category: "Security", description: "Delegates authorization decisions to an Open Policy Agent endpoint." },
  security_headers: { category: "Security", description: "Injects response security headers and strips fingerprinting headers." },
  cors: { category: "Security", description: "Cross-Origin Resource Sharing policy enforcement." },

  /* ── Traffic Control ── */
  rate_limiting: { category: "Traffic Control", description: "Request rate limiting by consumer, IP, or header." },
  request_size_limiting: { category: "Traffic Control", description: "Rejects request bodies above a byte limit." },
  response_size_limiting: { category: "Traffic Control", description: "Rejects response bodies above a byte limit." },
  tcp_connection_throttle: { category: "Traffic Control", description: "Caps concurrent TCP connections per client IP." },
  adaptive_concurrency: { category: "Traffic Control", description: "AIMD adaptive in-flight request limiting per backend target." },
  request_termination: { category: "Traffic Control", description: "Short-circuits requests with a fixed response (maintenance mode)." },
  request_deduplication: { category: "Traffic Control", description: "Idempotency-key based duplicate request suppression." },
  response_caching: { category: "Traffic Control", description: "In-memory response cache with TTL and cache-control support." },

  /* ── Transformations ── */
  request_transformer: { category: "Transformations", description: "Add/remove/replace request headers, query params, and body fields." },
  response_transformer: { category: "Transformations", description: "Add/remove/replace response headers and body fields." },
  compression: { category: "Transformations", description: "Response compression (gzip/brotli) and request decompression." },
  body_validator: { category: "Transformations", description: "JSON Schema validation of request/response bodies." },
  openapi_validator: { category: "Transformations", description: "Validates requests/responses against per-operation OpenAPI schemas." },
  request_mirror: { category: "Transformations", description: "Mirrors a percentage of traffic to a shadow backend." },
  response_mock: { category: "Transformations", description: "Returns mocked responses for matching requests." },
  serverless_function: { category: "Transformations", description: "Invokes a serverless function pre- or post-proxy." },
  graphql: { category: "Transformations", description: "GraphQL depth/complexity limits and per-type rate limits." },
  correlation_id: { category: "Transformations", description: "Generates and propagates correlation IDs." },

  /* ── Observability ── */
  stdout_logging: { category: "Observability", description: "Transaction logs to stdout." },
  http_logging: { category: "Observability", description: "Ships transaction logs to an HTTP endpoint." },
  tcp_logging: { category: "Observability", description: "Ships transaction logs over TCP." },
  udp_logging: { category: "Observability", description: "Ships transaction logs over UDP." },
  kafka_logging: { category: "Observability", description: "Ships transaction logs to Kafka." },
  loki_logging: { category: "Observability", description: "Ships transaction logs to Grafana Loki." },
  ws_logging: { category: "Observability", description: "Streams transaction logs over WebSocket." },
  statsd_logging: { category: "Observability", description: "Emits request metrics to StatsD." },
  prometheus_metrics: { category: "Observability", description: "Exposes Prometheus metrics (global scope only)." },
  otel_tracing: { category: "Observability", description: "OpenTelemetry trace export (OTLP/HTTP)." },
  transaction_debugger: { category: "Observability", description: "Captures detailed per-transaction debug info." },
  transaction_log_schema: { category: "Observability", description: "Registers named log schemas other logging plugins reference." },
  proxy_alerts: { category: "Observability", description: "In-gateway alerting to Slack/Teams/Discord/webhook/email channels." },
  workload_metrics: { category: "Observability", description: "Istio-style workload identity labels and telemetry tag overrides." },

  /* ── AI Gateway ── */
  ai_federation: { category: "AI Gateway", description: "Routes LLM requests across providers with failover." },
  ai_stream_router: { category: "AI Gateway", description: "Streaming LLM routing with SSE normalization across providers." },
  ai_prompt_shield: { category: "AI Gateway", description: "Detects/redacts PII and secrets in prompts." },
  ai_response_guard: { category: "AI Gateway", description: "Scans/redacts LLM responses for PII and blocked content." },
  ai_request_guard: { category: "AI Gateway", description: "Enforces model allowlists, token caps, and request shape." },
  ai_rate_limiter: { category: "AI Gateway", description: "Token-based rate limiting for LLM traffic." },
  ai_token_metrics: { category: "AI Gateway", description: "Token usage and cost metrics per request." },
  ai_semantic_cache: { category: "AI Gateway", description: "Embedding-similarity response cache for LLM calls." },
  ai_semantic_firewall: { category: "AI Gateway", description: "Semantic guardrails: prompt injection, jailbreaks, topic policy." },
  ai_prompt_compressor: { category: "AI Gateway", description: "Extractive prompt compression to cut token usage." },
  ai_tool_governor: { category: "AI Gateway", description: "Allow/deny/approval policy for AI tool and function calls." },
  ai_transcript_audit: { category: "AI Gateway", description: "Redacted AI transcript capture to a compliance collector." },
  mcp_gateway: { category: "AI Gateway", description: "MCP gateway: proxies or aggregates JSON-RPC MCP servers with tool policy." },
  a2a_gateway: { category: "AI Gateway", description: "Agent-to-Agent protocol gateway with method policy and card rewriting." },

  /* ── Mesh ── */
  mesh_authz: { category: "Mesh", description: "Istio-style ALLOW/DENY/AUDIT authorization policies over SPIFFE identities." },
  mesh_outbound_registry: { category: "Mesh", description: "REGISTRY_ONLY outbound policy: rejects hosts outside the registry." },
  mesh_route_dispatch: { category: "Mesh", description: "VirtualService-style per-request route overrides, rewrites, and faults." },

  /* ── Streaming & Protocols ── */
  sse: { category: "Streaming & Protocols", description: "Server-Sent Events passthrough hardening." },
  grpc_web: { category: "Streaming & Protocols", description: "gRPC-Web to native gRPC bridging." },
  grpc_method_router: { category: "Streaming & Protocols", description: "Per-gRPC-method allow/deny and rate limits." },
  grpc_deadline: { category: "Streaming & Protocols", description: "Enforces and propagates gRPC deadlines." },
  ws_message_size_limiting: { category: "Streaming & Protocols", description: "Caps WebSocket frame sizes." },
  ws_rate_limiting: { category: "Streaming & Protocols", description: "WebSocket frame rate limiting." },
  ws_frame_logging: { category: "Streaming & Protocols", description: "Logs WebSocket frame activity." },
  udp_rate_limiting: { category: "Streaming & Protocols", description: "Datagram and byte rate limiting for UDP proxies." },

  /* ── Billing ── */
  api_chargeback: { category: "Billing", description: "Per-call API pricing with in-memory usage aggregation." },
  api_chargeback_sink: { category: "Billing", description: "Durable ClickHouse charge export with spool-backed delivery." },

  /* ── Testing ── */
  load_testing: { category: "Testing", description: "Built-in load generation against the gateway." },
  fault_injection: { category: "Testing", description: "Chaos testing: probabilistic aborts and injected latency." },
  spec_expose: { category: "Testing", description: "Serves an OpenAPI spec document at the proxy edge." },
};

export function getPluginMeta(pluginName: string): PluginMeta {
  return (
    PLUGIN_METADATA[pluginName] ?? {
      category: "Other",
      description: "Custom or unrecognized plugin type.",
    }
  );
}

/** Internal reserved plugins (auto-injected by the gateway, not user-configurable). */
export function isInternalPlugin(pluginName: string): boolean {
  return pluginName.startsWith("__");
}

/* ------------------------------------------------------------------ */
/*  Default (template) configs per plugin                             */
/* ------------------------------------------------------------------ */

const DEFAULT_PLUGIN_CONFIGS: Record<string, PluginConfigDefault> = {
  access_control: {
    allowed_groups: ["demo"],
    disallowed_groups: ["blocked"],
    allow_authenticated_identity: false,
  },
  adaptive_concurrency: {
    key_by: "proxy_target",
    min_limit: 1,
    initial_limit: 32,
    max_limit: 1024,
    min_samples: 20,
    target_latency_multiplier: 1.5,
    decrease_ratio: 0.8,
    increase_step: 1,
    shadow_mode: false,
    expose_headers: false,
  },
  a2a_gateway: {
    enabled: true,
    mode: "transparent_proxy",
    endpoint: {
      path: "/a2a",
      agent_card_path: "/.well-known/agent-card.json",
      protocol_versions: ["0.3.0"],
    },
    discovery: {
      rewrite_agent_card_urls: true,
      public_base_url: "https://agents.example.com",
    },
    policy: {
      default_action: "allow",
      methods: {
        "tasks/cancel": { action: "deny" },
      },
    },
  },
  ai_federation: {
    providers: [
      {
        name: "openai-primary",
        provider_type: "openai",
        priority: 1,
        api_key: "replace-with-provider-api-key",
        default_model: "gpt-4o-mini",
        model_patterns: ["gpt-*"],
        connect_timeout_seconds: 5,
        read_timeout_seconds: 60,
      },
    ],
    fallback_enabled: true,
    fallback_on_status_codes: [429, 500, 502, 503],
    preserve_original_model: true,
  },
  ai_prompt_compressor: {
    compress_roles: ["user"],
    target_ratio: 0.5,
    min_content_tokens: 200,
    request_family: "auto",
  },
  ai_prompt_shield: {
    action: "reject",
    scan_fields: "content",
    detectors: ["email", "phone", "credit_card", "ssn"],
    placeholder: "[REDACTED:{type}]",
    max_scan_bytes: 1048576,
    ignore_roles: ["system"],
    custom_patterns: [
      {
        name: "internal_ticket",
        regex: "FF-[0-9]{4,}",
      },
    ],
  },
  ai_rate_limiter: {
    token_limit: 100000,
    window_seconds: 60,
    count_mode: "total_tokens",
    limit_by: "consumer",
    expose_headers: true,
    provider: "auto",
  },
  ai_request_guard: {
    max_tokens_limit: 4096,
    enforce_max_tokens: "clamp",
    default_max_tokens: 1024,
    allowed_models: ["gpt-4o-mini", "gpt-4o"],
    blocked_models: [],
    require_user_field: false,
    max_messages: 64,
    max_prompt_characters: 50000,
    temperature_range: [0, 1.2],
    block_system_prompts: false,
    required_fields: ["model", "messages"],
  },
  ai_response_guard: {
    action: "redact",
    scan_fields: "content",
    placeholder: "[REDACTED:{type}]",
    max_scan_bytes: 1048576,
    detectors: ["email", "phone", "credit_card", "ssn"],
    blocked_phrases: ["internal only"],
    require_json: false,
    required_fields: [],
    max_completion_length: 20000,
  },
  ai_semantic_cache: {
    ttl_seconds: 300,
    max_entries: 10000,
    max_entry_size_bytes: 1048576,
    max_total_size_bytes: 104857600,
    include_model_in_key: true,
    include_params_in_key: false,
    scope_by_consumer: false,
  },
  ai_semantic_firewall: {
    enabled: true,
    mode: "dry_run",
    provider: {
      type: "openai_compatible_embeddings",
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      api_key_env: "OPENAI_API_KEY",
      request_timeout_ms: 5000,
    },
    builtins: {
      prompt_injection: true,
      jailbreak: true,
      system_prompt_exfiltration: true,
      data_exfiltration: true,
    },
    deny_topics: [
      {
        id: "competitor_pricing",
        examples: ["What does Acme charge for their enterprise plan?"],
        threshold: 0.78,
        action: "warn",
      },
    ],
  },
  ai_stream_router: {
    enabled: true,
    normalize_response_stream: true,
    inject_usage_options: true,
    providers: [
      {
        name: "openai-streaming",
        provider_type: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        api_key: "${OPENAI_API_KEY}",
        model_patterns: ["gpt-*", "o*"],
      },
      {
        name: "anthropic-streaming",
        provider_type: "anthropic",
        endpoint: "https://api.anthropic.com/v1/messages",
        api_key: "${ANTHROPIC_API_KEY}",
        model_patterns: ["claude-*"],
        anthropic_version: "2023-06-01",
      },
    ],
  },
  ai_token_metrics: {
    provider: "auto",
    include_model: true,
    include_token_details: true,
    metadata_prefix: "ai",
    cost_per_prompt_token: 0.00000015,
    cost_per_completion_token: 0.0000006,
  },
  ai_tool_governor: {
    enabled: true,
    mode: "enforce",
    default_action: "deny",
    inspect: {
      request_tool_definitions: true,
      response_tool_calls: true,
    },
    tools: {
      search_docs: { action: "allow", risk: "low" },
      execute_sql: {
        action: "redact_args",
        risk: "high",
        blocked_arg_patterns: [
          { name: "drop_table", regex: "(?i)drop\\s+table" },
        ],
      },
    },
    response: { deny_status_code: 403 },
    observability: { emit_metadata: true, hash_arguments: true },
  },
  ai_transcript_audit: {
    mode: "redacted_body",
    sampling: {
      rate: 1.0,
      always_capture_on_guardrail: true,
      always_capture_on_error: true,
    },
    redaction: {
      builtins: ["ssn", "credit_card", "email", "api_key"],
      hash_redacted_values: true,
    },
    sink: {
      endpoint_url: "https://audit-collector.example.com/v1/transcripts",
      batch_size: 50,
      flush_interval_ms: 1000,
      on_buffer_full: "drop",
      on_sink_error: "warn",
    },
    privacy: {
      include_consumer_username: true,
      path_mode: "template",
    },
  },
  api_chargeback: {
    currency: "USD",
    render_cache_ttl_seconds: 1,
    stale_entry_ttl_seconds: 3600,
    cache_invalidation_min_age_ms: 250,
    pricing_tiers: [
      {
        status_codes: [200, 201, 202, 204],
        price_per_call: 0.001,
      },
      {
        status_codes: [400, 401, 403, 404, 429, 500, 502, 503, 504],
        price_per_call: 0,
      },
    ],
  },
  api_chargeback_sink: {
    mode: "per_event",
    currency: "USD",
    pricing_tiers: [
      { status_codes: [200, 201, 204], price_per_call: 0.0001 },
    ],
    bandwidth_pricing: {
      price_per_byte_sent: 0,
      price_per_byte_received: 1e-9,
    },
    clickhouse: {
      url: "https://clickhouse.example.com:8443",
      database: "ferrum",
      table: "charges_raw",
      username: "ferrum",
      password_ref: "FERRUM_CLICKHOUSE_PASSWORD",
    },
    batch: { size: 500, flush_interval_ms: 2000 },
    spool: { enabled: true, dir: "/var/lib/ferrum/chargeback-spool" },
  },
  basic_auth: {},
  body_validator: {
    content_types: ["application/json"],
    required_fields: ["id"],
    json_schema: {
      type: "object",
      additionalProperties: true,
    },
    response_content_types: ["application/json"],
  },
  bot_detection: {
    blocked_patterns: ["BadBot", "sqlmap"],
    allow_list: ["FerrumDemoClient"],
    custom_response_code: 403,
    allow_missing_user_agent: true,
  },
  compression: {
    algorithms: ["gzip", "br"],
    min_content_length: 128,
    content_types: ["application/json", "text/plain", "text/html"],
    disable_on_etag: true,
    remove_accept_encoding: true,
    decompress_request: false,
    max_decompressed_request_size: 10485760,
    gzip_level: 6,
    brotli_quality: 4,
  },
  correlation_id: {
    header_name: "X-Correlation-ID",
    generator: "uuid",
    echo_downstream: true,
  },
  cors: {
    allowed_origins: ["http://localhost:5173", "http://localhost:8000"],
    allowed_methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowed_headers: ["Accept", "Authorization", "Content-Type", "X-API-Key"],
    exposed_headers: ["X-Correlation-ID", "X-Request-ID"],
    allow_credentials: false,
    max_age: 300,
    preflight_continue: false,
  },
  fault_injection: {
    abort: {
      status_code: 503,
      percentage: 5,
      body: '{"error":"injected fault"}',
    },
    delay: {
      duration_ms: 200,
      percentage: 10,
    },
  },
  geo_restriction: {
    db_path: "/path/to/GeoLite2-Country.mmdb",
    allow_countries: ["US", "CA"],
    deny_countries: [],
    inject_headers: true,
    on_lookup_failure: "allow",
  },
  graphql: {
    max_depth: 12,
    max_complexity: 250,
    max_aliases: 25,
    introspection_allowed: false,
    limit_by: "consumer",
    type_rate_limits: {
      query: {
        max_requests: 120,
        window_seconds: 60,
      },
      mutation: {
        max_requests: 30,
        window_seconds: 60,
      },
    },
  },
  grpc_deadline: {
    max_deadline_ms: 30000,
    default_deadline_ms: 5000,
    subtract_gateway_processing: true,
    reject_no_deadline: false,
  },
  grpc_method_router: {
    allow_methods: ["/demo.v1.Gateway/GetStatus"],
    deny_methods: [],
    method_rate_limits: {
      "demo.v1.Gateway/GetStatus": {
        max_requests: 120,
        window_seconds: 60,
      },
    },
    limit_by: "consumer",
  },
  grpc_web: {
    expose_headers: ["grpc-status", "grpc-message"],
  },
  hmac_auth: {
    clock_skew_seconds: 300,
  },
  http_logging: {
    endpoint_url: "http://127.0.0.1:9101/logs",
    batch_size: 50,
    flush_interval_ms: 1000,
    buffer_capacity: 10000,
    max_retries: 3,
    retry_delay_ms: 1000,
    custom_headers: {
      "x-source": "ferrum-edge",
    },
  },
  ip_restriction: {
    mode: "allow_first",
    allow: ["127.0.0.1/32", "::1/128"],
    deny: [],
  },
  jwks_auth: {
    providers: [
      {
        issuer: "http://localhost:8080/realms/dev",
        jwks_uri: "http://localhost:8080/realms/dev/protocol/openid-connect/certs",
        audience: "ferrum-edge",
        required_scopes: [],
        required_roles: [],
        consumer_identity_claim: "sub",
        consumer_header_claim: "email",
      },
    ],
    scope_claim: "scope",
    role_claim: "roles",
    consumer_identity_claim: "sub",
    consumer_header_claim: "email",
    jwks_refresh_interval_secs: 900,
  },
  jwt_auth: {
    token_lookup: "header:Authorization",
    consumer_claim_field: "sub",
  },
  kafka_logging: {
    broker_list: "127.0.0.1:9092",
    topic: "ferrum-gateway",
    key_field: "client_ip",
    compression: "lz4",
    flush_timeout_seconds: 5,
    buffer_capacity: 10000,
  },
  key_auth: {
    key_location: "header:X-API-Key",
  },
  ldap_auth: {
    url: "ldap://127.0.0.1:389",
    bind_dn: "cn=readonly,dc=example,dc=org",
    bind_password: "replace-with-bind-password",
    user_base_dn: "ou=people,dc=example,dc=org",
    user_filter: "(uid={username})",
    username_field: "username",
  },
  load_testing: {
    key: "dev-load-test",
    concurrent_clients: 5,
    duration_seconds: 30,
    ramp: true,
    request_timeout_ms: 30000,
    gateway_tls: false,
    gateway_port: 8000,
    gateway_addresses: [],
  },
  loki_logging: {
    endpoint_url: "http://127.0.0.1:3100/loki/api/v1/push",
    labels: {
      service: "ferrum-edge",
      environment: "dev",
    },
    include_listen_path_label: true,
    include_status_class_label: true,
    batch_size: 100,
    flush_interval_ms: 1000,
    buffer_capacity: 10000,
    gzip: true,
    max_retries: 3,
    retry_delay_ms: 1000,
  },
  mcp_gateway: {
    mode: "aggregate_router",
    endpoint: {
      path: "/mcp",
      protocol_versions: ["2025-11-25"],
    },
    servers: {
      github: {
        upstream_url: "https://mcp-github.internal.example.com/mcp",
        namespace: "github",
        expose_tools: true,
      },
    },
    policy: {
      default_action: "deny",
      tools: {
        "github.search_issues": { action: "allow" },
      },
    },
  },
  mesh_authz: {
    namespace: "default",
    mesh_policies: [
      {
        apiVersion: "security.istio.io/v1",
        kind: "AuthorizationPolicy",
        metadata: { name: "allow-frontend", namespace: "default" },
        spec: {
          action: "ALLOW",
          rules: [
            {
              from: [
                { source: { principals: ["cluster.local/ns/default/sa/frontend"] } },
              ],
            },
          ],
        },
      },
    ],
    trusted_hbone_assertors: ["ztunnel", "waypoint"],
  },
  mesh_outbound_registry: {
    registry: [
      "api.example.com",
      "*.internal.example.com:443",
      "payments.svc:8443",
    ],
    reject_status: 502,
  },
  mesh_route_dispatch: {
    rules: [
      {
        match: {
          methods: ["GET"],
          headers: { "x-canary": { exact: "true" } },
        },
        destination: {
          backend_host: "canary.internal",
          backend_port: 8080,
        },
      },
    ],
    reject_unmatched: false,
  },
  mtls_auth: {
    cert_field: "subject_cn",
    allowed_issuers: [
      {
        cn: "Ferrum Dev CA",
      },
    ],
    allowed_ca_fingerprints_sha256: [],
  },
  oauth2_introspection: {
    providers: [
      {
        introspection_endpoint: "https://auth.example.com/oauth2/introspect",
        issuer: "https://auth.example.com",
        audiences: ["api://ferrum"],
        client_auth: {
          method: "client_secret_basic",
          client_id: "ferrum-gateway",
          client_secret: "change-me-client-secret",
        },
        positive_cache_ttl_secs: 60,
        negative_cache_ttl_secs: 10,
      },
    ],
    scope_claim: "scope",
    role_claim: "roles",
    consumer_identity_claim: "username",
  },
  oidc_relying_party: {
    providers: [
      {
        issuer: "https://auth.example.com",
        discovery_url: "https://auth.example.com/.well-known/openid-configuration",
        client_id: "ferrum-dashboard",
        client_auth: {
          method: "client_secret_basic",
          client_secret: "change-me-client-secret",
        },
        redirect_uri: "https://app.example.com/oauth/callback",
        callback_path: "/oauth/callback",
        logout_path: "/oauth/logout",
        scopes: ["openid", "profile", "email"],
      },
    ],
    session: {
      encryption_secret: "change-me-32-byte-minimum-secret!!",
      cookie_name: "ferrum_session",
      ttl_secs: 3600,
      idle_ttl_secs: 1800,
      secure: true,
      same_site: "lax",
    },
  },
  opa: {
    opa_host: "http://opa.opa-system.svc.cluster.local:8181",
    policy_path: "ferrum/authz/allow",
    timeout_ms: 1000,
    fail_open: false,
    deny_status: 403,
    include_method: true,
    include_path: true,
    include_headers: true,
    include_consumer: true,
    include_client_ip: true,
  },
  openapi_validator: {
    enforcement_mode: "block",
    validate_request: true,
    validate_response: true,
    operations: [
      {
        method: "POST",
        path_template: "/orders",
        path_regex: "^/orders$",
        request_required: true,
        request_body: {
          content: {
            "application/json": {
              type: "object",
              required: ["item_id", "quantity"],
              properties: {
                item_id: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
              },
            },
          },
        },
        responses: {
          "201": { "application/json": { type: "object" } },
        },
      },
    ],
  },
  otel_tracing: {
    service_name: "ferrum-edge",
    deployment_environment: "dev",
    generate_trace_id: true,
    endpoint: "http://127.0.0.1:4318/v1/traces",
    headers: {},
    batch_size: 50,
    flush_interval_ms: 5000,
    buffer_capacity: 10000,
    max_retries: 2,
    retry_delay_ms: 1000,
  },
  prometheus_metrics: {
    render_cache_ttl_seconds: 1,
    stale_entry_ttl_seconds: 3600,
    cache_invalidation_min_age_ms: 250,
  },
  proxy_alerts: {
    enabled: true,
    default_cooldown_seconds: 300,
    default_window_seconds: 60,
    channels: {
      ops_slack: {
        type: "slack",
        webhook_url_env: "FERRUM_ALERTS_SLACK_WEBHOOK",
        channel_override: "#alerts-prod",
      },
    },
    rules: [
      {
        name: "proxy_5xx_spike",
        type: "error_rate",
        status_codes: [500, 502, 503, 504],
        threshold_percent: 5.0,
        min_request_count: 100,
        window_seconds: 60,
        channels: ["ops_slack"],
        cooldown_seconds: 300,
        severity: "high",
      },
    ],
  },
  rate_limiting: {
    limit_by: "consumer",
    expose_headers: true,
    requests_per_second: 400,
    requests_per_minute: 20000,
    sync_mode: "local",
  },
  request_deduplication: {
    header_name: "Idempotency-Key",
    ttl_seconds: 300,
    max_entries: 10000,
    applicable_methods: ["POST", "PUT", "PATCH"],
    scope_by_consumer: true,
    enforce_required: false,
  },
  request_mirror: {
    mirror_host: "127.0.0.1",
    mirror_protocol: "http",
    mirror_port: 9101,
    mirror_path: "/mirror",
    percentage: 10,
    mirror_request_body: true,
  },
  request_size_limiting: {
    max_bytes: 262144,
  },
  request_termination: {
    status_code: 503,
    content_type: "application/json",
    message: "Service temporarily unavailable",
    trigger: {
      header: "x-maintenance-mode",
      header_value: "true",
    },
  },
  request_transformer: {
    rules: [
      {
        operation: "add",
        target: "header",
        key: "X-Gateway",
        value: "ferrum-edge",
      },
    ],
  },
  response_caching: {
    ttl_seconds: 60,
    max_entries: 10000,
    max_entry_size_bytes: 1048576,
    max_total_size_bytes: 104857600,
    cache_methods: ["GET", "HEAD"],
    cache_status_codes: [200, 301, 404],
    respect_cache_control: true,
    respect_no_cache: true,
    cache_key_include_query: true,
    cache_key_include_consumer: false,
    add_cache_status_header: true,
    vary_by_headers: ["accept"],
  },
  response_mock: {
    rules: [
      {
        method: "GET",
        path: "/fixtures",
        status_code: 200,
        headers: {
          "content-type": "application/json",
        },
        body: '{"ok":true,"source":"response_mock"}',
        delay_ms: 15,
      },
    ],
    passthrough_on_no_match: true,
  },
  response_size_limiting: {
    max_bytes: 1048576,
    require_buffered_check: false,
  },
  response_transformer: {
    rules: [
      {
        operation: "add",
        target: "header",
        key: "X-Gateway-Response",
        value: "ferrum-edge",
      },
    ],
  },
  security_headers: {
    content_type_options: true,
    frame_options: "SAMEORIGIN",
    referrer_policy: "strict-origin-when-cross-origin",
    hsts: false,
    remove: ["server", "x-powered-by"],
    override_existing: true,
  },
  serverless_function: {
    provider: "azure_functions",
    function_url: "http://127.0.0.1:9101/functions/ferrum-hook",
    mode: "pre_proxy",
    forward_body: false,
    forward_query_params: true,
    forward_headers: ["x-correlation-id"],
    timeout_ms: 5000,
    max_response_body_bytes: 1048576,
    on_error: "continue",
    error_status_code: 502,
  },
  soap_ws_security: {
    timestamp: {
      require: true,
      max_age_seconds: 300,
      require_expires: false,
      clock_skew_seconds: 300,
    },
    username_token: {
      enabled: false,
      password_type: "PasswordDigest",
      users: [],
    },
    x509: {
      enabled: false,
      trusted_cert_paths: [],
    },
    saml: {
      enabled: false,
      audience: "ferrum-edge",
    },
    nonce_cache: {
      cache_ttl_seconds: 300,
      max_cache_size: 10000,
    },
  },
  spec_expose: {
    spec_url: "http://127.0.0.1:9101/openapi.yaml",
    content_type: "application/yaml",
    tls_no_verify: false,
  },
  spiffe_identity: {},
  sse: {
    require_accept_header: true,
    require_get_method: true,
    strip_accept_encoding: true,
    add_no_buffering_header: true,
    strip_content_length: true,
    retry_ms: 3000,
    force_sse_content_type: false,
    wrap_non_sse_responses: false,
  },
  statsd_logging: {
    host: "127.0.0.1",
    port: 8125,
    prefix: "ferrum",
    global_tags: {
      environment: "dev",
      service: "edge",
    },
    flush_interval_ms: 500,
    buffer_capacity: 10000,
    max_batch_lines: 50,
  },
  stdout_logging: {},
  tcp_connection_throttle: {
    max_connections_per_ip: 100,
  },
  tcp_logging: {
    host: "127.0.0.1",
    port: 9001,
    tls: false,
    batch_size: 50,
    flush_interval_ms: 1000,
    buffer_capacity: 10000,
    connect_timeout_ms: 5000,
    max_retries: 3,
    retry_delay_ms: 1000,
  },
  transaction_debugger: {
    capture_headers: ["authorization", "x-api-key", "x-correlation-id"],
    log_request_body: false,
    log_response_body: false,
  },
  transaction_log_schema: {
    schemas: {
      compact: {
        summary_type: "both",
        rename: { response_status_code: "status" },
        derived_fields: [{ name: "status_class", kind: "status_class" }],
        metadata: { mode: "omit" },
      },
    },
  },
  udp_logging: {
    host: "127.0.0.1",
    port: 9002,
    dtls: false,
    batch_size: 10,
    flush_interval_ms: 1000,
    buffer_capacity: 10000,
    max_retries: 1,
    retry_delay_ms: 500,
  },
  udp_rate_limiting: {
    datagrams_per_second: 1000,
    bytes_per_second: 1048576,
    window_seconds: 1,
  },
  waf: {
    mode: "enforce",
    paranoia_level: 1,
    default_rule_action: "monitor",
    request_inspection: true,
    request_body_inspection: true,
    response_inspection: false,
    include_default_rules: true,
    scoring: { enabled: true, block_threshold: 7 },
    reject_status_code: 403,
  },
  workload_metrics: {
    namespace: "default",
    workload_spiffe_id: "spiffe://cluster.local/ns/default/sa/api",
    labels: { app: "api", version: "v1" },
    sampling_percentage: 10,
    service_name: "api",
    trusted_hbone_assertors: ["ztunnel", "waypoint"],
  },
  ws_frame_logging: {
    log_level: "info",
    include_payload_preview: false,
    payload_preview_bytes: 128,
    log_ping_pong: false,
  },
  ws_logging: {
    endpoint_url: "ws://127.0.0.1:9101/ws-logs",
    batch_size: 50,
    flush_interval_ms: 1000,
    buffer_capacity: 10000,
    max_retries: 3,
    retry_delay_ms: 1000,
    reconnect_delay_ms: 5000,
  },
  ws_message_size_limiting: {
    max_frame_bytes: 1048576,
    close_message: "Message too large",
  },
  ws_rate_limiting: {
    frames_per_second: 100,
    burst_size: 200,
    close_message: "Frame rate exceeded",
  },
};

export function getPluginConfigDefault(pluginName: string): PluginConfigDefault {
  const config = DEFAULT_PLUGIN_CONFIGS[pluginName] ?? {};
  return JSON.parse(JSON.stringify(config)) as PluginConfigDefault;
}

export function formatPluginConfigDefault(pluginName: string): string {
  return JSON.stringify(getPluginConfigDefault(pluginName), null, 2);
}
