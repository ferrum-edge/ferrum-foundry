/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy API functions                              */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Proxy,
  ProxyCreate,
} from "./types";
import { collectAllPages } from "./pagination";

function withProxyId(data: ProxyCreate, id?: string): ProxyCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
): Promise<PaginatedResponse<Proxy>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("proxies", scoped(scope, { searchParams }))
    .json<PaginatedResponse<Proxy>>();
}

/** Every page is fetched under `scope`, however long the collection takes. */
export async function listAll(scope: NamespaceScope): Promise<Proxy[]> {
  return collectAllPages((offset, limit) => list(scope, { offset, limit }));
}

export async function get(scope: NamespaceScope, id: string): Promise<Proxy> {
  return proxyApi.get(`proxies/${id}`, scoped(scope)).json<Proxy>();
}

/**
 * Convert a fetched Proxy into a full-replace PUT payload. PUT is a full
 * replacement, so partial payloads would silently reset omitted fields.
 * Server-managed fields are stripped; everything else round-trips.
 */
export function toUpdatePayload(proxy: Proxy): ProxyCreate {
  const { created_at, updated_at, namespace, api_spec_id, ...rest } = proxy;
  void created_at;
  void updated_at;
  void namespace;
  void api_spec_id;
  return rest;
}

/**
 * Merge the fields owned by ProxyForm over a complete fetched resource.
 * Opaque/advanced fields that the form does not model continue to round-trip,
 * while absent form-owned optionals are explicit clears rather than an
 * accidental instruction to preserve stale state.
 */
export function mergeFormUpdatePayload(
  proxy: Proxy,
  changes: ProxyCreate,
): ProxyCreate {
  const payload = toUpdatePayload(proxy);

  const clearWhenAbsent: Array<keyof ProxyCreate> = [
    "name",
    "listen_path",
    "backend_path",
    "allowed_methods",
    "backend_tls_client_cert_path",
    "backend_tls_client_key_path",
    "backend_tls_server_ca_cert_path",
    "upstream_id",
    "upstream_subset",
    "dns_override",
    "dns_cache_ttl_seconds",
    "circuit_breaker",
    "retry",
    "pool_idle_timeout_seconds",
    "pool_enable_http_keep_alive",
    "pool_enable_http2",
    "pool_tcp_keepalive_seconds",
    "pool_http2_keep_alive_interval_seconds",
    "pool_http2_keep_alive_timeout_seconds",
    "pool_http2_initial_stream_window_size",
    "pool_http2_initial_connection_window_size",
    "pool_http2_adaptive_window",
    "pool_http2_max_frame_size",
    "pool_http2_max_concurrent_streams",
    "pool_max_requests_per_connection",
    "listen_port",
    "tcp_idle_timeout_seconds",
    "websocket_idle_timeout_seconds",
    "udp_max_response_amplification_factor",
    "pool_http3_connections_per_backend",
  ];

  for (const field of clearWhenAbsent) {
    if (!(field in changes)) {
      (payload as Record<string, unknown>)[field] = null;
    }
  }

  if (!("hosts" in changes)) payload.hosts = [];
  if (!("allowed_ws_origins" in changes)) payload.allowed_ws_origins = [];
  if (!("stream_proxy_protocol" in changes)) payload.stream_proxy_protocol = false;
  if (!("backend_proxy_protocol" in changes)) payload.backend_proxy_protocol = null;

  return { ...payload, ...changes, plugins: proxy.plugins ?? [] };
}

export async function create(
  scope: NamespaceScope,
  data: ProxyCreate,
): Promise<Proxy> {
  return proxyApi
    .post("proxies", scoped(scope, { json: withProxyId(data) }))
    .json<Proxy>();
}

export async function update(
  scope: NamespaceScope,
  id: string,
  data: ProxyCreate,
): Promise<Proxy> {
  return proxyApi
    .put(`proxies/${id}`, scoped(scope, { json: withProxyId(data, id) }))
    .json<Proxy>();
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await proxyApi.delete(`proxies/${id}`, scoped(scope));
}
