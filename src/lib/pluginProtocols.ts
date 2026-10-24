/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin/protocol applicability                     */
/* ------------------------------------------------------------------ */

import type { BackendScheme, PluginConfig, Proxy } from "@/api/types";

/**
 * Provenance for the stream-capable plugin matrix below. The gateway
 * decides applicability itself; Foundry only mirrors the documented
 * matrix so counts and authorization views match what actually runs.
 */
export const STREAM_PLUGIN_MATRIX_SOURCE =
  "ferrum-edge docs/tcp_udp_proxy.md (Compatible Plugins) and " +
  "docs/plugin_execution_order.md (stream matrix), checked against each " +
  "plugin's supported_protocols() at v0.9.15 (25b37395)";

/** Backend schemes served by the L4 stream listener rather than the HTTP stack. */
const STREAM_SCHEMES: ReadonlySet<BackendScheme> = new Set<BackendScheme>([
  "tcp",
  "tcps",
  "udp",
  "dtls",
]);

/** Stream schemes that carry a connection-oriented TCP listener. */
const TCP_STREAM_SCHEMES: ReadonlySet<BackendScheme> = new Set<BackendScheme>([
  "tcp",
  "tcps",
]);

/** Stream schemes that carry a datagram listener. */
const UDP_STREAM_SCHEMES: ReadonlySet<BackendScheme> = new Set<BackendScheme>([
  "udp",
  "dtls",
]);

/**
 * Plugins that declare Tcp or Udp support and are therefore invoked on
 * every stream listener. Anything absent from this set (and from the
 * scheme-restricted sets below) is HTTP-only: the gateway skips it on a
 * stream connection.
 */
const STREAM_CAPABLE_PLUGINS: ReadonlySet<string> = new Set([
  "ip_restriction",
  "spiffe_identity",
  "mtls_auth",
  "access_control",
  "mesh_authz",
  "geo_restriction",
  "rate_limiting",
  "correlation_id",
  "otel_tracing",
  "stdout_logging",
  "statsd_logging",
  "http_logging",
  "tcp_logging",
  "kafka_logging",
  "loki_logging",
  "udp_logging",
  "ws_logging",
  "prometheus_metrics",
  "api_chargeback",
  "api_chargeback_sink",
  "workload_metrics",
  "transaction_debugger",
  "fault_injection",
  "proxy_alerts",
]);

/**
 * `waf` declares the stream protocols only when its configuration gives it
 * live stream inspection (Edge `src/plugins/waf/mod.rs`, `supported_protocols`):
 * `mode` is not `disabled` and `config.stream` is effective, meaning it enables
 * `tcp_require_tls` or carries a signature whose `action` is not disabled. An
 * HTTP-only or disabled WAF stays HTTP-only. A configuration Edge would refuse
 * to construct (a wrongly typed field, an unknown mode or action, a signature
 * without `id` or `pattern`, a duplicate signature id) runs nowhere, so it
 * never counts as inspecting.
 */
const WAF_STREAM_MODES: ReadonlySet<string> = new Set(["enforce", "monitor"]);
const WAF_ENABLED_ACTIONS: ReadonlySet<string> = new Set([
  "enforce", "block", "reject", "monitor", "log", "warn",
]);
const WAF_DISABLED_ACTIONS: ReadonlySet<string> = new Set(["disabled", "disable", "off"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Edge's optional fields treat `null` as absent. */
function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function wafSignatureEnabled(signature: Record<string, unknown>): boolean {
  return absent(signature.action) || WAF_ENABLED_ACTIONS.has(signature.action as string);
}

function wafSignatureValid(signature: unknown): signature is Record<string, unknown> {
  if (!isRecord(signature) || !nonEmptyString(signature.id) || !nonEmptyString(signature.pattern)) {
    return false;
  }
  const action = signature.action;
  return absent(action) ||
    (typeof action === "string" && (WAF_ENABLED_ACTIONS.has(action) || WAF_DISABLED_ACTIONS.has(action)));
}

function wafInspectsStreams(config: unknown): boolean {
  if (!isRecord(config)) return false;
  const mode = config.mode;
  if (!absent(mode) && !(typeof mode === "string" && WAF_STREAM_MODES.has(mode))) return false;
  const stream = config.stream;
  if (!isRecord(stream)) return false;
  const requireTls = stream.tcp_require_tls;
  if (!absent(requireTls) && typeof requireTls !== "boolean") return false;
  const signatures = absent(stream.signatures) ? [] : stream.signatures;
  if (!Array.isArray(signatures) || !signatures.every(wafSignatureValid)) return false;
  if (new Set(signatures.map((signature) => signature.id)).size !== signatures.length) return false;
  return requireTls === true || signatures.some(wafSignatureEnabled);
}

/** Stream plugins restricted to the connection-oriented TCP listeners. */
const TCP_ONLY_STREAM_PLUGINS: ReadonlySet<string> = new Set([
  "tcp_connection_throttle",
]);

/** Stream plugins restricted to the datagram listeners. */
const UDP_ONLY_STREAM_PLUGINS: ReadonlySet<string> = new Set([
  "udp_rate_limiting",
]);

/**
 * The proxy's effective backend scheme. The admin API omits the field on
 * older rows, where HTTP is the documented default.
 */
function schemeOf(proxy: Pick<Proxy, "backend_scheme">): BackendScheme {
  return proxy.backend_scheme ?? "https";
}

/** True when the proxy is served by the L4 stream listener (tcp/tcps/udp/dtls). */
export function isStreamProxy(proxy: Pick<Proxy, "backend_scheme">): boolean {
  return STREAM_SCHEMES.has(schemeOf(proxy));
}

/**
 * Whether the gateway actually invokes `plugin` on this proxy.
 *
 * HTTP proxies run every plugin. Stream proxies run only the documented
 * stream-capable set, so an unknown or HTTP-only plugin attached globally
 * is never executed on a TCP/UDP listener. The configuration is required
 * because `waf`'s protocols depend on it.
 */
export function pluginAppliesToProxy(
  plugin: Pick<PluginConfig, "plugin_name" | "config">,
  proxy: Pick<Proxy, "backend_scheme">,
): boolean {
  if (!isStreamProxy(proxy)) return true;

  const pluginName = plugin.plugin_name;
  if (pluginName === "waf") return wafInspectsStreams(plugin.config);
  const scheme = schemeOf(proxy);
  if (TCP_ONLY_STREAM_PLUGINS.has(pluginName)) {
    return TCP_STREAM_SCHEMES.has(scheme);
  }
  if (UDP_ONLY_STREAM_PLUGINS.has(pluginName)) {
    return UDP_STREAM_SCHEMES.has(scheme);
  }
  return STREAM_CAPABLE_PLUGINS.has(pluginName);
}
