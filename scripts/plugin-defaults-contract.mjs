import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_PLUGIN_CONFIGS,
  PLUGIN_METADATA,
  getPluginConfigDefault,
  isInternalPlugin,
} from "../src/lib/pluginConfigDefaults.ts";

// Preserve previously reviewed admissions. Adding/removing a template requires
// reviewing its expectation against the pinned gateway, not silently skipping it.
// mesh_authz is admitted as native MeshPolicy input, not a Kubernetes CRD envelope.
export const ACCEPTED_PLUGIN_DEFAULTS = [
  "access_control", "adaptive_concurrency", "a2a_gateway", "ai_federation",
  "ai_prompt_compressor", "ai_prompt_shield", "ai_rate_limiter", "ai_request_guard",
  "ai_response_guard", "ai_semantic_cache", "ai_semantic_firewall", "ai_token_metrics",
  "ai_tool_governor", "ai_transcript_audit", "api_chargeback", "api_chargeback_sink",
  "basic_auth", "body_validator", "bot_detection", "compression", "correlation_id",
  "cors", "fault_injection", "geo_restriction", "graphql", "grpc_deadline",
  "grpc_method_router", "grpc_web", "http_logging", "ip_restriction", "jwks_auth",
  "jwt_auth", "key_auth", "ldap_auth", "loki_logging", "mcp_gateway",
  "mesh_authz", "mesh_outbound_registry", "mesh_route_dispatch", "oauth2_introspection",
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

// The OIDC template intentionally has no key; the contract injects a generated
// operator-owned value when checking the remaining template fields with Edge.
export const OPERATOR_INPUT_REQUIRED = {
  oidc_relying_party: "session.encryption_secret",
};

// Exact whole diagnostics, not substrings or a general 400 allowance. A changed
// reason or unexpected acceptance is a failure requiring contract review.
// kafka_logging is a gateway egress-policy boundary, not a missing broker.
export const OPERATOR_INPUT_REJECTIONS = {
  hmac_auth: {
    status: 400,
    error: "Invalid plugin config: hmac_auth: `replay_scope` is required for `ferrum-hmac-v2` — use `shared` together with sync_mode: `redis` for any deployment running more than one gateway replica, or `process` to declare a single-process deployment whose replay protection is not cross-replica",
  },
  mtls_auth: {
    status: 400,
    error: "Invalid plugin config: mtls_auth: `allowed_issuers[0].ca_certificate_pem` is required to cryptographically pin the issuer",
  },
  ai_stream_router: {
    status: 400,
    error: 'Invalid plugin config: ai_stream_router: provider "openai-streaming" `api_key` references a `FERRUM_PLUGIN_SECRET_<NAME>` env variable that is not set',
  },
  load_testing: {
    status: 400,
    error: "Invalid plugin config: load_testing: `key` must be at least 32 characters",
  },
  proxy_alerts: {
    status: 400,
    error: 'Invalid plugin config: proxy_alerts: channel "ops_slack": env var "FERRUM_PLUGIN_SECRET_ALERTS_SLACK_WEBHOOK" (referenced by `webhook_url_env`) is not set',
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

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function setValueAtPath(value, path, nextValue) {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce((current, key) => current?.[key], value);
  assert.ok(parent && typeof parent === "object", `${path} must have an object parent`);
  parent[keys.at(-1)] = nextValue;
}

export function assertOnlyRequiredOperatorInputs(name, config) {
  const defaults = getPluginConfigDefault(name);
  const requiredInput = OPERATOR_INPUT_REQUIRED[name];
  if (requiredInput) {
    const submitted = valueAtPath(config, requiredInput);
    const defaultValue = valueAtPath(defaults, requiredInput);
    assert.notEqual(submitted, defaultValue,
      `${name}: ${requiredInput} must differ from Foundry's default`);
    assert.equal(typeof submitted, "string", `${name}: ${requiredInput} must be a string`);
    const secret = Buffer.from(submitted, "base64");
    assert.equal(secret.length, 32, `${name}: ${requiredInput} must encode 32 random bytes`);
    assert.equal(secret.toString("base64"), submitted,
      `${name}: ${requiredInput} must be canonical base64`);

    const restored = structuredClone(config);
    setValueAtPath(restored, requiredInput, defaultValue);
    assert.deepEqual(restored, defaults,
      `${name}: only ${requiredInput} may differ from Foundry's defaults`);
    assert.equal(JSON.stringify(restored), JSON.stringify(defaults),
      `${name}: fields outside ${requiredInput} must retain their exact serialized values`);
    return;
  }

  assert.deepEqual(config, defaults, `${name}: config must equal Foundry's defaults`);
  assert.equal(JSON.stringify(config), JSON.stringify(defaults),
    `${name}: config must preserve Foundry's exact serialized defaults`);
}

export async function verifyPluginDefaults(exchange, { report = console.log } = {}) {
  const names = Object.keys(DEFAULT_PLUGIN_CONFIGS).sort();
  assert.deepEqual(names, Object.keys(PLUGIN_METADATA).filter((name) => !isInternalPlugin(name)).sort());
  const expectedNames = [
    ...ACCEPTED_PLUGIN_DEFAULTS,
    ...Object.keys(OPERATOR_INPUT_REJECTIONS),
    ...Object.keys(OPERATOR_INPUT_REQUIRED).filter((name) => !ACCEPTED_PLUGIN_DEFAULTS.includes(name)),
  ].sort();
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
    const requiredInput = OPERATOR_INPUT_REQUIRED[name];
    const config = getPluginConfigDefault(name);
    if (requiredInput) {
      try {
        assert.equal(valueAtPath(config, requiredInput), "",
          `${name}: ${requiredInput} must not have a template value`);
        config.session.encryption_secret = randomBytes(32).toString("base64");
        // Continue through the normal admission path with safe operator input.
      } catch (error) {
        failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
        continue;
      }
    }
    try {
      assertOnlyRequiredOperatorInputs(name, config);
    } catch (error) {
      failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
      continue;
    }
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
          config,
        },
      });
      results.push({
        name,
        scope: needsProxy ? "proxy" : "global",
        status: response.status,
        ...(requiredInput ? { field: requiredInput } : {}),
        error: response.body?.error,
      });
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
  const operatorInput =
    Object.keys(OPERATOR_INPUT_REJECTIONS).length + Object.keys(OPERATOR_INPUT_REQUIRED).length;
  return {
    templates: names.length,
    accepted: ACCEPTED_PLUGIN_DEFAULTS.length,
    operatorInput,
  };
}
