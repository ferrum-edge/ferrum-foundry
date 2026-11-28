/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – the order Ferrum Edge runs a proxy's plugins in   */
/* ------------------------------------------------------------------ */

import type { PluginConfig } from "../api/types";

/**
 * Where `PLUGIN_DEFAULT_PRIORITY` was transcribed from. `npm run
 * check:edge-source-parity` (`scripts/edge-source-parity.mjs`) re-reads the
 * file at `edge.source_commit` in the Pinned Gateway Contract job, and at Edge
 * `main` in the Edge Main Drift workflow, and fails when the table differs or
 * `commit` is not the checked commit.
 */
export const PLUGIN_CHAIN_ORDER_SOURCE = {
  repository: "ferrum-edge/ferrum-edge",
  path: "src/plugins/builtin_parity.rs",
  constant: "BUILTIN_PLUGIN_PARITY_META",
  release: "v0.9.21",
  commit: "f9915358c8032214f4034a17c28cdf72d14006c3",
} as const;

/**
 * Every built-in plugin's default priority (`BuiltinPluginParityMeta.priority`,
 * which Edge's own tests hold equal to each plugin's `Plugin::priority()`), in
 * Edge's declaration order. A configuration's `priority_override` replaces it.
 * Lower runs first.
 */
export const PLUGIN_DEFAULT_PRIORITY: ReadonlyMap<string, number> = new Map([
  ["otel_tracing", 25],
  ["correlation_id", 50],
  ["cors", 100],
  ["request_termination", 125],
  ["mesh_outbound_registry", 130],
  ["ip_restriction", 150],
  ["geo_restriction", 175],
  ["bot_detection", 200],
  ["spec_expose", 210],
  ["sse", 250],
  ["grpc_web", 260],
  ["grpc_method_router", 275],
  ["spiffe_identity", 940],
  ["mtls_auth", 950],
  ["jwks_auth", 1000],
  ["oauth2_introspection", 1050],
  ["oidc_relying_party", 1075],
  ["jwt_auth", 1100],
  ["key_auth", 1200],
  ["ldap_auth", 1250],
  ["basic_auth", 1300],
  ["hmac_auth", 1400],
  ["soap_ws_security", 1500],
  ["access_control", 2000],
  ["tcp_connection_throttle", 2050],
  ["mesh_authz", 2075],
  ["opa", 2080],
  ["adaptive_concurrency", 2090],
  ["request_deduplication", 3010],
  ["request_size_limiting", 2800],
  ["ws_message_size_limiting", 2810],
  ["graphql", 2850],
  ["rate_limiting", 2900],
  ["ws_rate_limiting", 2910],
  ["udp_rate_limiting", 2915],
  ["ai_transcript_audit", 2740],
  ["ai_prompt_shield", 2925],
  ["waf", 2930],
  ["fault_injection", 2940],
  ["body_validator", 2950],
  ["openapi_validator", 2960],
  ["ai_semantic_firewall", 2968],
  ["ai_request_guard", 2975],
  ["ai_tool_governor", 2978],
  ["ai_stream_router", 2984],
  ["mcp_gateway", 2992],
  ["a2a_gateway", 2993],
  ["mesh_route_dispatch", 2995],
  ["request_transformer", 3000],
  ["serverless_function", 3025],
  ["response_mock", 3030],
  ["grpc_deadline", 3050],
  ["load_testing", 3070],
  ["request_mirror", 3075],
  ["response_size_limiting", 3490],
  ["response_caching", 3500],
  ["response_transformer", 4000],
  ["compression", 4050],
  ["ai_prompt_compressor", 4055],
  ["ai_semantic_cache", 4057],
  ["ai_federation", 4060],
  ["ai_token_metrics", 4070],
  ["ai_response_guard", 4075],
  ["security_headers", 4080],
  ["ai_rate_limiter", 4200],
  ["stdout_logging", 9000],
  ["ws_frame_logging", 9050],
  ["statsd_logging", 9075],
  ["http_logging", 9100],
  ["tcp_logging", 9125],
  ["kafka_logging", 9150],
  ["loki_logging", 9155],
  ["udp_logging", 9160],
  ["ws_logging", 9175],
  ["transaction_debugger", 9200],
  ["proxy_alerts", 9250],
  ["prometheus_metrics", 9300],
  ["api_chargeback", 9350],
  ["api_chargeback_sink", 9351],
  ["workload_metrics", 9360],
  ["__mesh_bpf_metrics", 9365],
  ["transaction_log_schema", 9999],
]);

/**
 * The priority Edge orders this configuration by: its `priority_override`,
 * else the plugin's default. `undefined` for a plugin Foundry has no default
 * for (a custom plugin compiled into the gateway), whose place in the chain
 * Foundry cannot know.
 */
export function effectivePriority(plugin: Pick<PluginConfig, "plugin_name" | "priority_override">): number | undefined {
  return plugin.priority_override ?? PLUGIN_DEFAULT_PRIORITY.get(plugin.plugin_name);
}

const utf8 = new TextEncoder();

/** Rust's `str` ordering: bytewise over UTF-8. */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/**
 * Edge's chain order (`plugin_chain_order` in `src/plugin_cache.rs`): effective
 * priority, then plugin name. Edge sorts stably, so callers pass the plugins in
 * Edge's assembly order and ties keep it. A plugin without a known priority
 * sorts last here; callers that depend on its position must treat it as
 * unknown.
 */
export function comparePluginChainOrder(
  left: Pick<PluginConfig, "plugin_name" | "priority_override">,
  right: Pick<PluginConfig, "plugin_name" | "priority_override">,
): number {
  const leftPriority = effectivePriority(left) ?? Number.POSITIVE_INFINITY;
  const rightPriority = effectivePriority(right) ?? Number.POSITIVE_INFINITY;
  if (leftPriority !== rightPriority) return leftPriority < rightPriority ? -1 : 1;
  return compareUtf8(left.plugin_name, right.plugin_name);
}
