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

type ProxyPayload = ProxyCreate & { id: string };

function withProxyId(data: ProxyCreate, id?: string): ProxyPayload {
  return { ...data, id: id ?? data.id ?? "" };
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

export async function create(data: ProxyCreate): Promise<Proxy> {
  return proxyApi.post("proxies", { json: withProxyId(data) }).json<Proxy>();
}

export async function update(id: string, data: ProxyCreate): Promise<Proxy> {
  return proxyApi.put(`proxies/${id}`, { json: withProxyId(data, id) }).json<Proxy>();
}

export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`proxies/${id}`);
}
