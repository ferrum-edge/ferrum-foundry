/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Upstream,
  UpstreamCreate,
} from "./types";
import { collectAllPages } from "./pagination";

const upstreamWrites = new Map<string, Promise<void>>();

async function serializeWrite<T>(scope: NamespaceScope, id: string, write: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([scope.namespace, id]);
  const result = (upstreamWrites.get(key) ?? Promise.resolve()).then(write);
  const tail = result.then(() => undefined, () => undefined);
  upstreamWrites.set(key, tail);
  try {
    return await result;
  } finally {
    if (upstreamWrites.get(key) === tail) upstreamWrites.delete(key);
  }
}

function withUpstreamId(data: UpstreamCreate, id?: string): UpstreamCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
): Promise<PaginatedResponse<Upstream>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("upstreams", scoped(scope, { searchParams }))
    .json<PaginatedResponse<Upstream>>();
}

/** Every page is fetched under `scope`, however long the collection takes. */
export async function listAll(scope: NamespaceScope): Promise<Upstream[]> {
  return collectAllPages((offset, limit) => list(scope, { offset, limit }));
}

export async function get(scope: NamespaceScope, id: string): Promise<Upstream> {
  return proxyApi.get(`upstreams/${id}`, scoped(scope)).json<Upstream>();
}

/** Strip server- and mesh-owned fields from a fetched full-replace resource. */
export function toUpdatePayload(upstream: Upstream): UpstreamCreate {
  const {
    created_at,
    updated_at,
    namespace,
    api_spec_id,
    port_overrides,
    source_locality,
    source_labels,
    locality_lb_setting,
    locality_lb_strict,
    ...rest
  } = upstream;
  void created_at;
  void updated_at;
  void namespace;
  void api_spec_id;
  void port_overrides;
  void source_locality;
  void source_labels;
  void locality_lb_setting;
  void locality_lb_strict;
  return rest;
}

/**
 * Merge a complete form-owned change set over every other writable field.
 * Nested form sections intentionally replace their whole canonical object so
 * explicit clears cannot be confused with preservation.
 */
export function mergeFormUpdatePayload(
  upstream: Upstream,
  changes: UpstreamCreate,
): UpstreamCreate {
  const base = toUpdatePayload(upstream);
  const merged: UpstreamCreate = {
    ...base,
    ...changes,
    targets: changes.targets,
  };

  const clearWhenAbsent: Array<keyof UpstreamCreate> = [
    "name",
    "hash_on",
    "hash_on_cookie_config",
    "health_checks",
    "service_discovery",
    "subsets",
    "backend_tls_client_cert_path",
    "backend_tls_client_key_path",
    "backend_tls_server_ca_cert_path",
    "backend_tls_sni",
  ];
  for (const field of clearWhenAbsent) {
    if (!(field in changes)) {
      (merged as Record<string, unknown>)[field] = null;
    }
  }
  if (!("backend_tls_san_allow_list" in changes)) {
    merged.backend_tls_san_allow_list = [];
  }

  return merged;
}

export async function create(
  scope: NamespaceScope,
  data: UpstreamCreate,
): Promise<Upstream> {
  return proxyApi
    .post("upstreams", scoped(scope, { json: withUpstreamId(data) }))
    .json<Upstream>();
}

export async function update(
  scope: NamespaceScope,
  id: string,
  data: UpstreamCreate,
): Promise<Upstream> {
  return serializeWrite(scope, id, () => put(scope, id, data));
}

function put(scope: NamespaceScope, id: string, data: UpstreamCreate): Promise<Upstream> {
  return proxyApi
    .put(`upstreams/${id}`, scoped(scope, { json: withUpstreamId(data, id) }))
    .json<Upstream>();
}

/** Targets own only the target list; all settings come from a current read. */
export async function updateTargets(
  scope: NamespaceScope,
  id: string,
  targets: UpstreamCreate["targets"],
): Promise<Upstream> {
  return serializeWrite(scope, id, async () => {
    const current = await get(scope, id);
    return put(scope, id, { ...toUpdatePayload(current), targets });
  });
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await serializeWrite(scope, id, async () => {
    await proxyApi.delete(`upstreams/${id}`, scoped(scope));
  });
}
