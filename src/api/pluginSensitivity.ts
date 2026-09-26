/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Ferrum Edge's plugin configuration sensitivity   */
/*                                                                    */
/*  A transcription of the per-plugin rules Ferrum Edge projects a    */
/*  plugin `config` by for a non-admin read. `secretRedaction.ts`     */
/*  uses them to decide which submitted values a failed write must    */
/*  not echo. The module imports nothing, so the drift check           */
/*  (`scripts/plugin-sensitivity-drift.mjs`) can load it directly and  */
/*  diff it against the Edge source CI pins.                           */
/* ------------------------------------------------------------------ */

/**
 * Where the table below comes from: `PLUGIN_SENSITIVITY_SCHEMAS` and
 * `KAFKA_SAFE_PRODUCER_PROPERTIES` in Edge's plugin configuration projection,
 * at the commit of the Edge image CI qualifies (`edge.source_commit` in
 * `docs/compatibility.json`). The drift check fails when the table differs
 * from that source, or when `commit` is not that commit: moving the pin means
 * re-reading the table, even when nothing in it changed.
 */
export const PLUGIN_SENSITIVITY_SOURCE = {
  repository: "ferrum-edge/ferrum-edge",
  path: "src/admin/plugin_config_projection.rs",
  /** The Edge source the table was last checked against. */
  commit: "8fed1346ce2e267eb69c03683cb89ea44d785e0b",
  /** The Edge release at that commit. */
  release: "v0.9.7",
} as const;

/**
 * How Ferrum Edge projects a schema-declared plugin `config` path for a
 * non-admin read (`FieldSensitivity`), and so which of its values a failed
 * write must not echo: a `secret` wholesale, the credential-bearing parts of
 * an `endpoint` or `redis` URL (the whole value when it is not a URL), and
 * every `kafka` producer property off the safe list.
 */
export type Sensitivity = "secret" | "endpoint" | "redis" | "kafka";

export interface SensitivityRule {
  readonly path: readonly string[];
  readonly sensitivity: Sensitivity;
}

const secret = (...path: string[]): SensitivityRule => ({ path, sensitivity: "secret" });
const endpoint = (...path: string[]): SensitivityRule => ({ path, sensitivity: "endpoint" });
const redis = (...path: string[]): SensitivityRule => ({ path, sensitivity: "redis" });
const REDIS_BACKED = [redis("redis_url")];
const NONE: readonly SensitivityRule[] = [];

/**
 * Edge's `PLUGIN_SENSITIVITY_SCHEMAS`, transcribed rule for rule. A plugin
 * named here gets its rules plus the name floor and URL sweep in
 * `secretRedaction.ts`; a plugin not named here (a custom plugin, or a
 * built-in added after `PLUGIN_SENSITIVITY_SOURCE`) has no schema Foundry can
 * classify by, so every string it carries is treated as secret.
 */
export const PLUGIN_SENSITIVITY = new Map<string, readonly SensitivityRule[]>([
  ["otel_tracing", [endpoint("endpoint"), secret("authorization"), secret("headers", "*")]],
  ["correlation_id", NONE],
  ["cors", NONE],
  ["request_termination", NONE],
  ["mesh_outbound_registry", NONE],
  ["ip_restriction", NONE],
  ["geo_restriction", NONE],
  ["bot_detection", NONE],
  ["spec_expose", [endpoint("spec_url")]],
  ["sse", NONE],
  ["grpc_web", NONE],
  ["grpc_method_router", REDIS_BACKED],
  ["spiffe_identity", NONE],
  ["mtls_auth", NONE],
  ["jwks_auth", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "jwks_uri"),
    endpoint("discovery_url"),
    endpoint("jwks_uri"),
  ]],
  ["oauth2_introspection", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "introspection_endpoint"),
    endpoint("discovery_url"),
    endpoint("introspection_endpoint"),
  ]],
  ["oidc_relying_party", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "jwks_uri"),
    endpoint("providers", "*", "token_endpoint"),
    endpoint("providers", "*", "authorization_endpoint"),
    endpoint("providers", "*", "userinfo_endpoint"),
    endpoint("providers", "*", "end_session_endpoint"),
    endpoint("discovery_url"),
    endpoint("jwks_uri"),
    endpoint("token_endpoint"),
    endpoint("authorization_endpoint"),
    endpoint("userinfo_endpoint"),
    endpoint("end_session_endpoint"),
  ]],
  ["jwt_auth", NONE],
  ["key_auth", NONE],
  ["ldap_auth", [endpoint("ldap_url")]],
  ["basic_auth", NONE],
  ["hmac_auth", NONE],
  ["soap_ws_security", NONE],
  ["access_control", NONE],
  ["tcp_connection_throttle", NONE],
  ["mesh_authz", NONE],
  ["opa", [secret("headers", "*")]],
  ["adaptive_concurrency", NONE],
  ["request_deduplication", REDIS_BACKED],
  ["request_size_limiting", NONE],
  ["ws_message_size_limiting", NONE],
  ["graphql", REDIS_BACKED],
  ["rate_limiting", REDIS_BACKED],
  ["ws_rate_limiting", REDIS_BACKED],
  ["udp_rate_limiting", REDIS_BACKED],
  ["ai_transcript_audit", [
    endpoint("sink", "endpoint_url"),
    secret("sink", "custom_headers", "*"),
    endpoint("endpoint_url"),
    secret("headers", "*"),
    secret("custom_headers", "*"),
  ]],
  ["ai_prompt_shield", NONE],
  ["waf", NONE],
  ["fault_injection", NONE],
  ["body_validator", NONE],
  ["openapi_validator", NONE],
  ["ai_semantic_firewall", [endpoint("provider", "endpoint")]],
  ["ai_request_guard", NONE],
  ["ai_tool_governor", [endpoint("endpoint_url"), endpoint("approval", "endpoint_url")]],
  ["ai_stream_router", [endpoint("providers", "*", "endpoint")]],
  ["mcp_gateway", [endpoint("servers", "*", "upstream_url"), endpoint("upstream_url")]],
  ["a2a_gateway", NONE],
  ["mesh_route_dispatch", NONE],
  ["ai_semantic_cache", [
    redis("redis_url"),
    endpoint("semantic_embedding_endpoint"),
    secret("semantic_embedding_auth_header"),
  ]],
  ["request_transformer", NONE],
  ["serverless_function", [
    endpoint("function_url"),
    endpoint("aws_endpoint_url"),
    secret("azure_function_key"),
  ]],
  ["response_mock", NONE],
  ["grpc_deadline", NONE],
  ["load_testing", NONE],
  ["request_mirror", NONE],
  ["response_size_limiting", NONE],
  ["response_caching", NONE],
  ["response_transformer", NONE],
  ["compression", NONE],
  ["ai_prompt_compressor", NONE],
  ["ai_federation", [endpoint("base_url"), endpoint("providers", "*", "base_url")]],
  ["ai_response_guard", NONE],
  ["security_headers", NONE],
  ["ai_token_metrics", NONE],
  ["ai_rate_limiter", REDIS_BACKED],
  ["stdout_logging", NONE],
  ["ws_frame_logging", NONE],
  ["statsd_logging", NONE],
  ["http_logging", [endpoint("endpoint_url"), secret("custom_headers", "*")]],
  ["tcp_logging", NONE],
  ["kafka_logging", [{ path: ["producer_config"], sensitivity: "kafka" }]],
  ["loki_logging", [
    endpoint("endpoint_url"),
    secret("authorization_header"),
    secret("custom_headers", "*"),
  ]],
  ["udp_logging", NONE],
  ["ws_logging", [endpoint("endpoint_url")]],
  ["transaction_debugger", NONE],
  ["proxy_alerts", [
    endpoint("channels", "*", "webhook_url"),
    endpoint("channels", "*", "url"),
    secret("channels", "*", "headers", "*"),
    secret("channels", "*", "body_template"),
  ]],
  ["prometheus_metrics", NONE],
  ["api_chargeback", NONE],
  ["api_chargeback_sink", [
    endpoint("clickhouse", "url"),
    secret("clickhouse", "insert_query_params", "*"),
  ]],
  ["workload_metrics", [
    endpoint("tracing_provider", "config", "url"),
    endpoint("tracing_provider", "config", "agent_url"),
    endpoint("tracing_provider", "config", "collector_url"),
    endpoint("tracing_provider", "config", "endpoint"),
    endpoint("tracing_providers", "*", "config", "url"),
    endpoint("tracing_providers", "*", "config", "agent_url"),
    endpoint("tracing_providers", "*", "config", "collector_url"),
    endpoint("tracing_providers", "*", "config", "endpoint"),
  ]],
  ["__mesh_bpf_metrics", NONE],
  ["transaction_log_schema", NONE],
]);

/**
 * Edge's `KAFKA_SAFE_PRODUCER_PROPERTIES`: the librdkafka properties that carry
 * no credential. Every other `producer_config` property — `ssl.key.pem`,
 * `sasl.password`, and whatever librdkafka marks sensitive next — is secret.
 */
export const KAFKA_SAFE_PRODUCER_PROPERTIES: ReadonlySet<string> = new Set([
  "acks",
  "batch.num.messages",
  "batch.size",
  "client.id",
  "compression.codec",
  "compression.level",
  "compression.type",
  "delivery.timeout.ms",
  "enable.idempotence",
  "linger.ms",
  "max.in.flight",
  "max.in.flight.requests.per.connection",
  "message.max.bytes",
  "message.send.max.retries",
  "message.timeout.ms",
  "metadata.max.age.ms",
  "partitioner",
  "queue.buffering.max.kbytes",
  "queue.buffering.max.messages",
  "queue.buffering.max.ms",
  "reconnect.backoff.max.ms",
  "reconnect.backoff.ms",
  "request.required.acks",
  "request.timeout.ms",
  "retries",
  "retry.backoff.max.ms",
  "retry.backoff.ms",
  "socket.keepalive.enable",
  "socket.nagle.disable",
  "socket.timeout.ms",
  "sticky.partitioning.linger.ms",
  "topic.metadata.refresh.interval.ms",
]);
