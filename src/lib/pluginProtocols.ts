/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin/protocol applicability                     */
/* ------------------------------------------------------------------ */

import type { BackendScheme, Proxy } from "@/api/types";

/**
 * Provenance for the stream-capable plugin matrix below. The gateway
 * decides applicability itself; Foundry only mirrors the documented
 * matrix so counts and authorization views match what actually runs.
 */
export const STREAM_PLUGIN_MATRIX_SOURCE =
  "ferrum-edge docs/tcp_udp_proxy.md (Compatible Plugins) and " +
  "docs/plugin_execution_order.md (stream matrix)";

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
  "api_chargeback_sink",
  "workload_metrics",
  "transaction_debugger",
]);

/** Stream plugins restricted to the connection-oriented TCP listeners. */
const TCP_ONLY_STREAM_PLUGINS: ReadonlySet<string> = new Set([
  "tcp_connection_throttle",
]);

/** Stream plugins restricted to the datagram listeners. */
const UDP_ONLY_STREAM_PLUGINS: ReadonlySet<string> = new Set([
  "udp_rate_limiting",
]);

/** Every plugin name that runs on at least one stream scheme. */
export const STREAM_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  ...STREAM_CAPABLE_PLUGINS,
  ...TCP_ONLY_STREAM_PLUGINS,
  ...UDP_ONLY_STREAM_PLUGINS,
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
 * Whether the gateway actually invokes `pluginName` on this proxy.
 *
 * HTTP proxies run every plugin. Stream proxies run only the documented
 * stream-capable set, so an unknown or HTTP-only plugin attached globally
 * is never executed on a TCP/UDP listener.
 */
export function pluginAppliesToProxy(
  pluginName: string,
  proxy: Pick<Proxy, "backend_scheme">,
): boolean {
  if (!isStreamProxy(proxy)) return true;

  const scheme = schemeOf(proxy);
  if (TCP_ONLY_STREAM_PLUGINS.has(pluginName)) {
    return TCP_STREAM_SCHEMES.has(scheme);
  }
  if (UDP_ONLY_STREAM_PLUGINS.has(pluginName)) {
    return UDP_STREAM_SCHEMES.has(scheme);
  }
  return STREAM_CAPABLE_PLUGINS.has(pluginName);
}
