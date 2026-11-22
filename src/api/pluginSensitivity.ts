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
  commit: "f9915358c8032214f4034a17c28cdf72d14006c3",
  /** The Edge release at that commit. */
  release: "v0.9.21",
} as const;

/**
 * How Ferrum Edge projects a schema-declared plugin `config` path for a
 * non-admin read (`FieldSensitivity`), and so which of its values a failed
 * write must not echo: a `secret` wholesale, the credential-bearing parts of
 * an `endpoint` or `redis` URL (the whole value when it is not a URL), and
 * every `kafka` producer property off the safe list.
 *
 * Edge v0.9.21 (ferrum-edge#7054) adds three TLS and path classes:
 *
 * - `certificate` (`CertificateSource`): a certificate or CA source, inline
 *   PEM or a reference. It stays visible unless it carries a PEM private-key
 *   block (a certificate-plus-key bundle) or is not a string.
 * - `private-key` (`PrivateKeySource`): a private-key source. A reference
 *   stays visible; any PEM armour or control character, or a non-string, is
 *   withheld.
 * - `endpoint-path` (`EndpointPath`): an outbound path configured apart from
 *   its host. `""` and `/` stay visible; anything else is withheld.
 *
 * Each is withheld as the exact `[REDACTED]`, which Edge also refuses when a
 * non-admin write sends it back (`refusedPlaceholderSites`).
 */
export type Sensitivity =
  | "secret"
  | "endpoint"
  | "redis"
  | "kafka"
  | "certificate"
  | "private-key"
  | "endpoint-path";

export interface SensitivityRule {
  readonly path: readonly string[];
  readonly sensitivity: Sensitivity;
}

const secret = (...path: string[]): SensitivityRule => ({ path, sensitivity: "secret" });
const endpoint = (...path: string[]): SensitivityRule => ({ path, sensitivity: "endpoint" });
const redis = (...path: string[]): SensitivityRule => ({ path, sensitivity: "redis" });
const privateKey = (...path: string[]): SensitivityRule => ({ path, sensitivity: "private-key" });
const endpointPath = (...path: string[]): SensitivityRule => ({
  path,
  sensitivity: "endpoint-path",
});
const certificate = (...path: string[]): SensitivityRule => ({ path, sensitivity: "certificate" });
const REDIS_BACKED = [redis("redis_url")];
const NONE: readonly SensitivityRule[] = [];
const MESH_AUTHZ: readonly SensitivityRule[] = [
  secret("mesh_policies", "*", "rules", "*", "to", "*", "headers", "*"),
  secret("mesh_policies", "*", "rules", "*", "when", "*", "values", "*"),
  secret("mesh_policies", "*", "rules", "*", "when", "*", "not_values", "*"),
  secret("mesh_slice", "mesh_policies", "*", "rules", "*", "to", "*", "headers", "*"),
  secret("mesh_slice", "mesh_policies", "*", "rules", "*", "when", "*", "values", "*"),
  secret("mesh_slice", "mesh_policies", "*", "rules", "*", "when", "*", "not_values", "*"),
  secret(
    "mesh_slice",
    "node_waypoint_capture_mesh_policies",
    "*",
    "rules",
    "*",
    "to",
    "*",
    "headers",
    "*",
  ),
  secret(
    "mesh_slice",
    "node_waypoint_capture_mesh_policies",
    "*",
    "rules",
    "*",
    "when",
    "*",
    "values",
    "*",
  ),
  secret(
    "mesh_slice",
    "node_waypoint_capture_mesh_policies",
    "*",
    "rules",
    "*",
    "when",
    "*",
    "not_values",
    "*",
  ),
  secret("mesh_slice", "ext_authz_providers", "*", "include_additional_headers_in_check", "*", "value"),
  secret("mesh_slice", "ext_authz_providers", "*", "path_prefix"),
  secret("mesh_slice", "proxy_configs", "*", "environment", "*"),
  secret("mesh_slice", "extension_configs", "*", "value"),
  endpoint("mesh_slice", "telemetry_resources", "*", "config", "tracing", "providers", "*", "config", "url"),
  endpoint("mesh_slice", "telemetry_resources", "*", "config", "tracing", "providers", "*", "config", "agent_url"),
  endpoint("mesh_slice", "telemetry_resources", "*", "config", "tracing", "providers", "*", "config", "collector_url"),
  endpoint("mesh_slice", "telemetry_resources", "*", "config", "tracing", "providers", "*", "config", "endpoint"),
  endpoint("mesh_slice", "request_authentications", "*", "jwt_rules", "*", "jwks_uri"),
  endpoint("mesh_slice", "multi_cluster", "federation_endpoint"),
  endpoint("mesh_slice", "multi_cluster", "remote_clusters", "*", "control_plane_url"),
  endpoint("mesh_slice", "multi_cluster", "remote_clusters", "*", "federation_endpoint"),
];

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
  ["request_termination", [secret("trigger", "header_value")]],
  ["mesh_outbound_registry", NONE],
  ["ip_restriction", NONE],
  ["geo_restriction", NONE],
  ["bot_detection", NONE],
  ["spec_expose", [endpoint("spec_url")]],
  ["sse", NONE],
  ["grpc_web", NONE],
  ["grpc_method_router", REDIS_BACKED],
  ["spiffe_identity", NONE],
  ["mtls_auth", [certificate("allowed_issuers", "*", "ca_certificate_pem")]],
  ["jwks_auth", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "jwks_uri"),
    endpoint("discovery_url"),
    endpoint("jwks_uri"),
    redis("redis_url"),
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
  ["ldap_auth", [endpoint("ldap_url"), endpoint("failover_ldap_urls")]],
  ["basic_auth", NONE],
  ["hmac_auth", REDIS_BACKED],
  ["soap_ws_security", [
    certificate("x509_signature", "trusted_certs", "*"),
    certificate("saml", "trusted_signing_certs", "*"),
    redis("redis_url"),
  ]],
  ["access_control", NONE],
  ["tcp_connection_throttle", NONE],
  ["mesh_authz", MESH_AUTHZ],
  ["opa", [endpoint("opa_host"), secret("headers", "*")]],
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
  ["waf", [
    secret("global_exemptions", "header_present", "*"),
    secret("custom_rules", "*", "conditions", "headers", "*"),
    secret("rule_overrides", "*", "conditions", "headers", "*"),
  ]],
  ["fault_injection", [secret("match", "headers", "*")]],
  ["body_validator", NONE],
  ["openapi_validator", [secret("bypass", "header_present", "*")]],
  ["ai_semantic_firewall", [
    endpoint("provider", "endpoint"),
    secret("privacy", "snippet_hash_salt"),
  ]],
  ["ai_request_guard", NONE],
  ["ai_tool_governor", [
    endpoint("endpoint_url"),
    endpoint("approval", "endpoint_url"),
    secret("approval", "headers", "*"),
  ]],
  ["ai_stream_router", [endpoint("providers", "*", "endpoint")]],
  ["mcp_gateway", [
    endpoint("servers", "*", "upstream_url"),
    endpoint("upstream_url"),
    secret("servers", "*", "headers", "*"),
  ]],
  ["a2a_gateway", NONE],
  ["mesh_route_dispatch", [
    secret("rules", "*", "request_transform", "*", "value"),
    secret("rules", "*", "match", "headers", "*", "*"),
    secret("rules", "*", "match", "without_headers", "*", "*"),
    secret("rules", "*", "match", "query_params", "*", "*"),
    endpointPath("rules", "*", "rewrite", "uri"),
  ]],
  ["ai_semantic_cache", [
    redis("redis_url"),
    endpoint("semantic_embedding_endpoint"),
    secret("semantic_embedding_auth_header"),
  ]],
  ["request_transformer", [secret("rules", "*", "value")]],
  ["serverless_function", [
    endpoint("function_url"),
    endpoint("aws_endpoint_url"),
    secret("azure_function_key"),
  ]],
  ["response_mock", [
    secret("rules", "*", "match", "headers", "*"),
    secret("rules", "*", "match", "query_params", "*"),
  ]],
  ["grpc_deadline", NONE],
  ["load_testing", NONE],
  ["request_mirror", [endpointPath("mirror_path")]],
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
  ["udp_logging", [
    privateKey("dtls_key_path"),
    certificate("dtls_cert_path"),
    certificate("dtls_ca_cert_path"),
  ]],
  ["ws_logging", [endpoint("endpoint_url"), secret("custom_headers", "*")]],
  ["transaction_debugger", [secret("capture_request_header_value")]],
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
