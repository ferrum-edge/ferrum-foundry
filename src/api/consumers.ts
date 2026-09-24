/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, SILENT_ERRORS, type NamespaceScope } from "./client";
import type {
  BuiltInCredentialType,
  Consumer,
  ConsumerCredentialInput,
  ConsumerCreate,
  PaginatedResponse,
  PaginationParams,
} from "./types";
import { collectAllPages } from "./pagination";
import {
  conditionalDelete,
  conditionalPut,
  guardedRemove,
  guardedReplace,
  readTagged,
  uncomparedGuard,
  type WriteGuard,
} from "./conditionalWrite";
import {
  baselineSnapshot,
  CONSUMER_BASELINE_OMIT,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";

// Coordinate this UI's writes by their explicit namespace and consumer id.
// A metadata PUT reads credentials only after earlier rotation writes finish.
const consumerWrites = new Map<string, Promise<void>>();

async function serializeWrite<T>(scope: NamespaceScope, id: string, write: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([scope.namespace, id]);
  const previous = consumerWrites.get(key) ?? Promise.resolve();
  const result = previous.then(write);
  const tail = result.then(() => undefined, () => undefined);
  consumerWrites.set(key, tail);
  try {
    return await result;
  } finally {
    if (consumerWrites.get(key) === tail) consumerWrites.delete(key);
  }
}

/** Ordinary editor writes cannot replay a render-time credential projection. */
export function toUpdatePayload(data: ConsumerCreate): ConsumerCreate {
  const payload = { ...data };
  delete payload.credentials;
  return payload;
}

function withConsumerId(data: ConsumerCreate, id?: string): ConsumerCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
  signal?: AbortSignal,
): Promise<PaginatedResponse<Consumer>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("consumers", scoped(scope, { searchParams, signal }))
    .json<PaginatedResponse<Consumer>>();
}

/** Every page is fetched under `scope`, however long the collection takes. */
export async function listAll(
  scope: NamespaceScope,
  signal?: AbortSignal,
): Promise<Consumer[]> {
  return collectAllPages(
    (offset, limit, pageSignal) => list(scope, { offset, limit }, pageSignal),
    undefined,
    signal,
  );
}

export async function get(scope: NamespaceScope, id: string): Promise<Consumer> {
  return (await readTagged<Consumer>(scope, `consumers/${id}`)).value;
}

export async function create(
  scope: NamespaceScope,
  data: ConsumerCreate,
): Promise<Consumer> {
  return proxyApi
    .post("consumers", scoped(scope, { json: withConsumerId(data) }))
    .json<Consumer>();
}

/** Reduce a consumer, or a consumer payload, to the metadata a save replaces. */
export function toBaseline(consumer: Consumer | ConsumerCreate): BaselineSnapshot {
  return baselineSnapshot(consumer, CONSUMER_BASELINE_OMIT);
}

/**
 * The guard a consumer editor builds from the consumer it rendered: the
 * Details form from its seed, an ACL change from the consumer whose group
 * list it edited (the same rule as `upstreams.targetsWriteGuard`).
 */
export function consumerWriteGuard(
  seed: Consumer,
): WriteGuard<Consumer | ConsumerCreate> {
  return { baseline: toBaseline(seed), select: toBaseline };
}

/**
 * Full-replacement metadata update.
 *
 * Consumer PUT replaces represented credential types even when the whole
 * credentials field is omitted, so the body carries the credentials of the
 * read it is sent against, taken inside this write queue; only dedicated
 * credential endpoints edit secrets. That read is also what `guard` is
 * compared with and what `If-Match` comes from, so a rotation committed after
 * it makes the gateway refuse the write instead of it replaying stale
 * credentials. The guard then re-reads and re-sends with the rotated set.
 *
 * `guard` is the editor's baseline; pass `null` only for a write that cannot
 * lose a concurrent metadata change. An unguarded write is still conditional
 * on its credential read. See `docs/concurrent-edits.md`.
 */
export async function update(
  scope: NamespaceScope,
  id: string,
  data: ConsumerCreate,
  guard: WriteGuard<Consumer | ConsumerCreate> | null,
): Promise<Consumer> {
  const path = `consumers/${id}`;
  const metadata = toUpdatePayload(data);
  return serializeWrite(scope, id, () =>
    guardedReplace<Consumer, ConsumerCreate>({
      resource: "consumer",
      id,
      namespace: scope.namespace,
      guard: guard ?? uncomparedGuard(),
      read: () => readTagged<Consumer>(scope, path),
      propose: (current) =>
        withConsumerId({ ...metadata, credentials: current.credentials }, id),
      write: (body, ifMatch) => conditionalPut<Consumer>(scope, path, body, ifMatch),
    }),
  );
}

/**
 * Delete a consumer, only if its metadata still matches what the detail page
 * shows — see `proxies.remove`. Pass `null` only with nothing to compare.
 */
export async function remove(
  scope: NamespaceScope,
  id: string,
  guard: WriteGuard<Consumer | ConsumerCreate> | null,
): Promise<void> {
  const path = `consumers/${id}`;
  await serializeWrite(scope, id, () =>
    guard
      ? guardedRemove<Consumer>({
          resource: "consumer",
          id,
          namespace: scope.namespace,
          guard,
          read: () => readTagged<Consumer>(scope, path),
          remove: (ifMatch) => conditionalDelete(scope, path, ifMatch),
        })
      : conditionalDelete(scope, path, null),
  );
}

// ── Credential sub-endpoints ─────────────────────────────────────

export async function updateCredentials(
  scope: NamespaceScope,
  consumerId: string,
  credType: BuiltInCredentialType,
  data: ConsumerCredentialInput | ConsumerCredentialInput[],
): Promise<Consumer> {
  return serializeWrite(scope, consumerId, async () => {
    return proxyApi
      .put(
        `consumers/${consumerId}/credentials/${credType}`,
        // The replacement form handles failure without retaining echoed secrets.
        scoped(scope, { json: data, context: { [SILENT_ERRORS]: true } }),
      )
      .json<Consumer>();
  });
}

export async function appendCredential(
  scope: NamespaceScope,
  consumerId: string,
  credType: BuiltInCredentialType,
  data: ConsumerCredentialInput,
): Promise<Consumer> {
  return serializeWrite(scope, consumerId, async () => {
    return proxyApi
      .post(
        `consumers/${consumerId}/credentials/${credType}`,
        scoped(scope, { json: data }),
      )
      .json<Consumer>();
  });
}

export async function deleteCredentials(
  scope: NamespaceScope,
  consumerId: string,
  credType: string,
): Promise<void> {
  await serializeWrite(scope, consumerId, async () => {
    await proxyApi.delete(
      `consumers/${consumerId}/credentials/${credType}`,
      scoped(scope),
    );
  });
}

export async function deleteCredentialByIndex(
  scope: NamespaceScope,
  consumerId: string,
  credType: string,
  index: number,
): Promise<void> {
  await serializeWrite(scope, consumerId, async () => {
    await proxyApi.delete(
      `consumers/${consumerId}/credentials/${credType}/${index}`,
      scoped(scope),
    );
  });
}
