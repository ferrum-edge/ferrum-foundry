import assert from "node:assert/strict";
import {
  DEFAULT_PLUGIN_CONFIGS,
  PLUGIN_METADATA,
  getPluginConfigDefault,
  isInternalPlugin,
} from "../src/lib/pluginConfigDefaults.ts";

// Preserve the previously accepted controls as well as the 13 repaired defaults.
// Membership is deliberate: adding/removing a template requires reviewing its
// admission expectation against the pinned gateway, not silently skipping it.
export const ACCEPTED_PLUGIN_DEFAULTS = [
  "access_control", "adaptive_concurrency", "a2a_gateway", "ai_federation",
  "ai_prompt_compressor", "ai_prompt_shield", "ai_rate_limiter", "ai_request_guard",
  "ai_response_guard", "ai_semantic_cache", "ai_semantic_firewall", "ai_token_metrics",
  "ai_tool_governor", "ai_transcript_audit", "api_chargeback", "api_chargeback_sink",
  "basic_auth", "body_validator", "bot_detection", "compression", "correlation_id",
  "cors", "fault_injection", "geo_restriction", "graphql", "grpc_deadline",
  "grpc_method_router", "grpc_web", "http_logging", "ip_restriction", "jwks_auth",
  "jwt_auth", "key_auth", "ldap_auth", "loki_logging", "mcp_gateway",
  "mesh_outbound_registry", "mesh_route_dispatch", "oauth2_introspection",
  "oidc_relying_party", "opa", "otel_tracing", "prometheus_metrics", "rate_limiting",
  "request_deduplication", "request_mirror", "request_size_limiting",
  "request_termination", "request_transformer", "response_caching", "response_mock",
  "response_size_limiting", "response_transformer", "security_headers",
  "serverless_function", "soap_ws_security", "spec_expose", "spiffe_identity", "sse",
  "statsd_logging", "stdout_logging", "tcp_connection_throttle", "tcp_logging",
  "transaction_debugger", "transaction_log_schema", "udp_logging", "udp_rate_limiting",
  "waf", "workload_metrics", "ws_frame_logging", "ws_logging",
  "ws_message_size_limiting", "ws_rate_limiting",
];

// Exact whole diagnostics, not substrings or a general 400 allowance. A changed
// reason or unexpected acceptance is a failure requiring contract review.
// mesh_authz is a known native-policy input boundary (the sample is a K8s CRD),
// and kafka_logging is a gateway egress-policy boundary, not a missing broker.
export const OPERATOR_INPUT_REJECTIONS = {
  hmac_auth: {
    status: 400,
    error: "Invalid plugin config: hmac_auth: 'replay_scope' is required for 'ferrum-hmac-v2' — use 'shared' together with sync_mode: 'redis' for any deployment running more than one gateway replica, or 'process' to declare a single-process deployment whose replay protection is not cross-replica",
  },
  mtls_auth: {
    status: 400,
    error: "Invalid plugin config: mtls_auth: 'allowed_issuers[0].ca_certificate_pem' is required to cryptographically pin the issuer",
  },
  ai_stream_router: {
    status: 400,
    error: "Invalid plugin config: ai_stream_router: provider 'openai-streaming' missing 'api_key'",
  },
  load_testing: {
    status: 400,
    error: "Invalid plugin config: load_testing: 'key' must be at least 32 characters",
  },
  mesh_authz: {
    status: 400,
    error: "Invalid plugin config: mesh_authz: invalid mesh_policies: missing field `name`",
  },
  proxy_alerts: {
    status: 400,
    error: "Invalid plugin config: proxy_alerts: channel 'ops_slack': env var 'FERRUM_ALERTS_SLACK_WEBHOOK' (referenced by 'webhook_url_env') is not set",
  },
  kafka_logging: {
    status: 400,
    error: "Invalid plugin config fields: kafka_logging: cannot be admitted while a restrictive backend egress policy is in force: the pinned librdkafka client resolves bootstrap hostnames itself and dials brokers advertised by cluster metadata, and rdkafka 0.39 exposes no connect/resolve callback, so those addresses cannot be screened. Ferrum fails closed rather than leaving an unenforced egress path. Use a different log sink (http_logging, tcp_logging, ws_logging, loki_logging), or accept an unrestricted backend egress policy (FERRUM_BACKEND_ALLOW_IPS=both, no FERRUM_BACKEND_DENY_CIDRS, FERRUM_BACKEND_BLOCK_DANGEROUS_RANGES=false)",
  },
  openapi_validator: {
    status: 400,
    error: "openapi_validator requires a proxy with an attached api_spec",
  },
};

function assertStatus(response, expected, context) {
  assert.ok(expected.includes(response.status),
    `${context}: expected ${expected.join("/")}, received ${response.status}: ${JSON.stringify(response.body)}`);
}

export async function verifyPluginDefaults(exchange, { report = console.log } = {}) {
  const names = Object.keys(DEFAULT_PLUGIN_CONFIGS).sort();
  assert.deepEqual(names, Object.keys(PLUGIN_METADATA).filter((name) => !isInternalPlugin(name)).sort());
  const expectedNames = [...ACCEPTED_PLUGIN_DEFAULTS, ...Object.keys(OPERATOR_INPUT_REJECTIONS)].sort();
  assert.equal(new Set(expectedNames).size, 81, "review catalog membership when changing the 81-template baseline");
  assert.deepEqual(names, expectedNames, "every real template needs an explicit admission expectation");
  const catalog = await exchange("/plugins");
  assertStatus(catalog, [200], "gateway plugin catalog");
  assert.ok(Array.isArray(catalog.body));
  assert.deepEqual(catalog.body.filter((name) => !isInternalPlugin(name)).sort(), names,
    "the pinned gateway and Foundry must expose the same non-internal catalog");

  const failures = [];
  const results = [];
  for (const name of names) {
    const id = `contract-default-${name}`;
    // A TCP throttle must target a TCP listener. OpenAPI admission must reach
    // the attached-spec precondition, rather than stopping at incorrect scope.
    const needsProxy = name === "openapi_validator" || name === "tcp_connection_throttle";
    const proxyId = `${id}-proxy`;
    const pluginPath = `/plugins/config/${id}`;
    let isolationLost = false;
    try {
      if (needsProxy) {
        const proxy = {
          id: proxyId,
          name: proxyId,
          backend_host: "127.0.0.1",
          backend_port: 9101,
          plugins: [],
          ...(name === "tcp_connection_throttle"
            ? { backend_scheme: "tcp", listen_port: 19191 }
            : { backend_scheme: "http", listen_path: "/contract-default-openapi" }),
        };
        assertStatus(await exchange("/proxies?apply=sync", { method: "POST", body: proxy }),
          [201], `${name} proxy fixture`);
      }
      const response = await exchange("/plugins/config?apply=sync", {
        method: "POST",
        body: {
          id,
          plugin_name: name,
          scope: needsProxy ? "proxy" : "global",
          ...(needsProxy ? { proxy_id: proxyId } : {}),
          enabled: true,
          config: getPluginConfigDefault(name),
        },
      });
      results.push({ name, scope: needsProxy ? "proxy" : "global", status: response.status, error: response.body?.error });
      const rejection = OPERATOR_INPUT_REJECTIONS[name];
      assertStatus(response, [rejection?.status ?? 201], name);
      if (rejection) {
        assert.deepEqual(response.body, { error: rejection.error }, `${name}: rejection reason drift`);
      } else {
        const persisted = await exchange(pluginPath);
        assertStatus(persisted, [200], `${name} readback`);
        assert.equal(persisted.body.plugin_name, name);
        assert.equal(persisted.body.enabled, true);
      }
    } catch (error) {
      failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
    } finally {
      // Also remove an unexpectedly accepted exemption or a write whose apply
      // response failed after persistence. Never leave a global plugin active
      // for the next template, or unrelated plugin composition can mask drift.
      try {
        assertStatus(await exchange(`${pluginPath}?apply=sync`, { method: "DELETE" }),
          [200, 204, 404], `${name} cleanup`);
        if (needsProxy) {
          assertStatus(await exchange(`/proxies/${proxyId}?apply=sync`, { method: "DELETE" }),
            [200, 204, 404], `${name} proxy cleanup`);
        }
      } catch (error) {
        // Isolation is lost; subsequent submissions would no longer be valid controls.
        failures.push(new Error(`${name} cleanup: ${error.message}`, { cause: error }));
        isolationLost = true;
      }
    }
    if (isolationLost) break;
  }
  report(JSON.stringify({ pluginDefaults: results }));
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
  return { templates: names.length, accepted: ACCEPTED_PLUGIN_DEFAULTS.length, operatorInput: Object.keys(OPERATOR_INPUT_REJECTIONS).length };
}
