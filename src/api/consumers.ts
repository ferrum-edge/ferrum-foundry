/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";
import type {
  BuiltInCredentialType,
  Consumer,
  ConsumerCredentialInput,
  ConsumerCreate,
  PaginatedResponse,
  PaginationParams,
} from "./types";
import { collectAllPages } from "./pagination";

function withConsumerId(data: ConsumerCreate, id?: string): ConsumerCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
): Promise<PaginatedResponse<Consumer>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("consumers", scoped(scope, { searchParams }))
    .json<PaginatedResponse<Consumer>>();
}

/** Every page is fetched under `scope`, however long the collection takes. */
export async function listAll(scope: NamespaceScope): Promise<Consumer[]> {
  return collectAllPages((offset, limit) => list(scope, { offset, limit }));
}

export async function get(scope: NamespaceScope, id: string): Promise<Consumer> {
  return proxyApi.get(`consumers/${id}`, scoped(scope)).json<Consumer>();
}

export async function create(
  scope: NamespaceScope,
  data: ConsumerCreate,
): Promise<Consumer> {
  return proxyApi
    .post("consumers", scoped(scope, { json: withConsumerId(data) }))
    .json<Consumer>();
}

export async function update(
  scope: NamespaceScope,
  id: string,
  data: ConsumerCreate,
): Promise<Consumer> {
  return proxyApi
    .put(`consumers/${id}`, scoped(scope, { json: withConsumerId(data, id) }))
    .json<Consumer>();
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await proxyApi.delete(`consumers/${id}`, scoped(scope));
}

// ── Credential sub-endpoints ─────────────────────────────────────

export async function updateCredentials(
  scope: NamespaceScope,
  consumerId: string,
  credType: BuiltInCredentialType,
  data: ConsumerCredentialInput | ConsumerCredentialInput[],
): Promise<Consumer> {
  return proxyApi
    .put(
      `consumers/${consumerId}/credentials/${credType}`,
      scoped(scope, { json: data }),
    )
    .json<Consumer>();
}

export async function appendCredential(
  scope: NamespaceScope,
  consumerId: string,
  credType: BuiltInCredentialType,
  data: ConsumerCredentialInput,
): Promise<Consumer> {
  return proxyApi
    .post(
      `consumers/${consumerId}/credentials/${credType}`,
      scoped(scope, { json: data }),
    )
    .json<Consumer>();
}

export async function deleteCredentials(
  scope: NamespaceScope,
  consumerId: string,
  credType: string,
): Promise<void> {
  await proxyApi.delete(
    `consumers/${consumerId}/credentials/${credType}`,
    scoped(scope),
  );
}

export async function deleteCredentialByIndex(
  scope: NamespaceScope,
  consumerId: string,
  credType: string,
  index: number,
): Promise<void> {
  await proxyApi.delete(
    `consumers/${consumerId}/credentials/${credType}/${index}`,
    scoped(scope),
  );
}
