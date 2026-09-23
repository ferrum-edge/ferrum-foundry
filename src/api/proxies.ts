/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy API functions                              */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, SILENT_ERRORS, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Proxy,
  ProxyCreate,
} from "./types";
import { collectAllPages } from "./pagination";
import {
  conditionalPut,
  guardedReplace,
  readTagged,
  type WriteGuard,
} from "./conditionalWrite";
import {
  baselineSnapshot,
  PROXY_BASELINE_OMIT,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";

function withProxyId(data: ProxyCreate, id?: string): ProxyCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

/**
 * `GET /proxies` accepts only `offset` and `limit`. There is no `search`,
 * `name`, or reference filter on the admin API, so a search still has to be
 * answered by traversing the collection — see `docs/data-loading.md`.
 */
export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
  signal?: AbortSignal,
): Promise<PaginatedResponse<Proxy>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("proxies", scoped(scope, { searchParams, signal }))
    .json<PaginatedResponse<Proxy>>();
}

/**
 * Every page is fetched under `scope`, however long the collection takes.
 * `signal` lets the caller abandon the traversal — a namespace switch, a new
 * search term, or an unmounted page — instead of paying for pages nobody will
 * read.
 */
export async function listAll(
  scope: NamespaceScope,
  signal?: AbortSignal,
): Promise<Proxy[]> {
  return collectAllPages(
    (offset, limit, pageSignal) => list(scope, { offset, limit }, pageSignal),
    undefined,
    signal,
  );
}

export async function get(scope: NamespaceScope, id: string): Promise<Proxy> {
  return proxyApi.get(`proxies/${id}`, scoped(scope)).json<Proxy>();
}

/**
 * Resolve one proxy a picker already holds the id of.
 *
 * A selection can point at a proxy outside the page the picker loaded, or at
 * one that has since been deleted. Neither is a fault to report in the global
 * error dialog: the picker shows the id and says the label could not be
 * resolved, and the selection itself is preserved either way.
 */
export async function getReference(
  scope: NamespaceScope,
  id: string,
  signal?: AbortSignal,
): Promise<Proxy> {
  return proxyApi
    .get(
      `proxies/${id}`,
      scoped(scope, { signal, context: { [SILENT_ERRORS]: true } }),
    )
    .json<Proxy>();
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

  // ProxyForm does not own membership. Edge preserves the current live
  // associations only when this key is absent, so never replay a cached list.
  const merged = { ...payload, ...changes };
  delete merged.plugins;
  return merged;
}

export async function create(
  scope: NamespaceScope,
  data: ProxyCreate,
): Promise<Proxy> {
  return proxyApi
    .post("proxies", scoped(scope, { json: withProxyId(data) }))
    .json<Proxy>();
}

/**
 * Reduce a proxy — or a proxy write payload — to the content a full-replace
 * save overwrites. The editor captures this when it opens and the guard
 * compares it against a fresh read just before the `PUT`.
 */
export function toBaseline(proxy: Proxy | ProxyCreate): BaselineSnapshot {
  return baselineSnapshot(proxy, PROXY_BASELINE_OMIT);
}

/** The guard shape a proxy editor builds from the resource it was seeded with. */
export function proxyWriteGuard(seed: Proxy): WriteGuard<Proxy | ProxyCreate> {
  return { baseline: toBaseline(seed), select: toBaseline };
}

/**
 * Full-replacement update.
 *
 * `guard` carries the content the editor opened against. Pass `null` only for
 * a write that cannot lose a concurrent change — there is no default, because
 * an omitted guard is exactly the silent overwrite this argument exists to
 * prevent. A guarded call re-reads the proxy, throws `StaleResourceError`
 * without writing when another writer got there first, and otherwise sends the
 * `PUT` with `If-Match` set to the tag of the read it just verified, so the
 * gateway refuses it if anything commits in between. See
 * `docs/concurrent-edits.md`.
 */
export async function update(
  scope: NamespaceScope,
  id: string,
  data: ProxyCreate,
  guard: WriteGuard<Proxy | ProxyCreate> | null,
): Promise<Proxy> {
  const payload = withProxyId(data, id);
  const path = `proxies/${id}`;

  if (!guard) return conditionalPut<Proxy>(scope, path, payload, null);

  return guardedReplace<Proxy, ProxyCreate>({
    resource: "proxy",
    id,
    namespace: scope.namespace,
    guard,
    read: () => readTagged<Proxy>(scope, path),
    propose: () => payload,
    write: (body, ifMatch) => conditionalPut<Proxy>(scope, path, body, ifMatch),
  });
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await proxyApi.delete(`proxies/${id}`, scoped(scope));
}
