/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy API functions                              */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Proxy,
  ProxyCreate,
} from "./types";

function withProxyId(data: ProxyCreate, id?: string): ProxyCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  params: PaginationParams = {},
): Promise<PaginatedResponse<Proxy>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi.get("proxies", { searchParams }).json<PaginatedResponse<Proxy>>();
}

export async function get(id: string): Promise<Proxy> {
  return proxyApi.get(`proxies/${id}`).json<Proxy>();
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

export async function create(data: ProxyCreate): Promise<Proxy> {
  return proxyApi.post("proxies", { json: withProxyId(data) }).json<Proxy>();
}

export async function update(id: string, data: ProxyCreate): Promise<Proxy> {
  return proxyApi.put(`proxies/${id}`, { json: withProxyId(data, id) }).json<Proxy>();
}

export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`proxies/${id}`);
}
