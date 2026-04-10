/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type {
  Consumer,
  ConsumerCreate,
  PaginatedResponse,
  PaginationParams,
} from "./types";

type ConsumerPayload = ConsumerCreate & { id: string };

function withConsumerId(data: ConsumerCreate, id?: string): ConsumerPayload {
  return { ...data, id: id ?? data.id ?? "" };
}

export async function list(
  params: PaginationParams = {},
): Promise<PaginatedResponse<Consumer>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("consumers", { searchParams })
    .json<PaginatedResponse<Consumer>>();
}

export async function get(id: string): Promise<Consumer> {
  return proxyApi.get(`consumers/${id}`).json<Consumer>();
}

export async function create(data: ConsumerCreate): Promise<Consumer> {
  return proxyApi.post("consumers", { json: withConsumerId(data) }).json<Consumer>();
}

export async function update(
  id: string,
  data: ConsumerCreate,
): Promise<Consumer> {
  return proxyApi.put(`consumers/${id}`, { json: withConsumerId(data, id) }).json<Consumer>();
}

export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`consumers/${id}`);
}

// ── Credential sub-endpoints ─────────────────────────────────────

export async function updateCredentials(
  consumerId: string,
  credType: string,
  data: unknown,
): Promise<Consumer> {
  return proxyApi
    .put(`consumers/${consumerId}/credentials/${credType}`, { json: data })
    .json<Consumer>();
}

export async function appendCredential(
  consumerId: string,
  credType: string,
  data: unknown,
): Promise<Consumer> {
  return proxyApi
    .post(`consumers/${consumerId}/credentials/${credType}`, { json: data })
    .json<Consumer>();
}

export async function deleteCredentials(
  consumerId: string,
  credType: string,
): Promise<void> {
  await proxyApi.delete(`consumers/${consumerId}/credentials/${credType}`);
}

export async function deleteCredentialByIndex(
  consumerId: string,
  credType: string,
  index: number,
): Promise<void> {
  await proxyApi.delete(
    `consumers/${consumerId}/credentials/${credType}/${index}`,
  );
}
