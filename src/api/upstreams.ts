/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Upstream,
  UpstreamCreate,
} from "./types";

export async function list(
  params: PaginationParams = {},
): Promise<PaginatedResponse<Upstream>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("upstreams", { searchParams })
    .json<PaginatedResponse<Upstream>>();
}

export async function get(id: string): Promise<Upstream> {
  return proxyApi.get(`upstreams/${id}`).json<Upstream>();
}

export async function create(data: UpstreamCreate): Promise<Upstream> {
  return proxyApi.post("upstreams", { json: data }).json<Upstream>();
}

export async function update(
  id: string,
  data: UpstreamCreate,
): Promise<Upstream> {
  return proxyApi.put(`upstreams/${id}`, { json: data }).json<Upstream>();
}

export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`upstreams/${id}`);
}
