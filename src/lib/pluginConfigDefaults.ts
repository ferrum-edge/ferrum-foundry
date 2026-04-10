type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PluginConfigDefault = { [key: string]: JsonValue };

const DEFAULT_PLUGIN_CONFIGS: Record<string, PluginConfigDefault> = {
  access_control: {
    allowed_groups: ["demo"],
    disallowed_groups: ["blocked"],
    allow_authenticated_identity: false,
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
  ai_token_metrics: {
    provider: "auto",
    include_model: true,
    include_token_details: true,
    metadata_prefix: "ai",
    cost_per_prompt_token: 0.00000015,
    cost_per_completion_token: 0.0000006,
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
  example_audit_plugin: {},
  example_plugin: {},
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
  mtls_auth: {
    cert_field: "subject_cn",
    allowed_issuers: [
      {
        cn: "Ferrum Dev CA",
      },
    ],
    allowed_ca_fingerprints_sha256: [],
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
        body: "{\"ok\":true,\"source\":\"response_mock\"}",
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
