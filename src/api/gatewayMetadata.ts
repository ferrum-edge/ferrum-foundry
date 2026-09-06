import { APPLY_WAIT_MS } from "../../server/waitBudget";

export type ApplyState =
  | "idle"
  | "nothing_applied"
  | "pending"
  | "succeeded"
  | "applied"
  | "rejected"
  | "unverifiable";

export interface ConfigCursor {
  raw: string;
  epoch: string;
  sequence: string;
}

export interface ApplyStatusResponse {
  topology_epoch: number | string;
  sequence: number | string;
  state: "applied" | "pending" | "rejected" | "unverifiable";
  accepted_topology_epoch: number | string;
  accepted_sequence: number | string;
}

export interface GatewayMetadataSnapshot {
  cachedResponse: { url: string; observedAt: string } | null;
  etag: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  apply: {
    state: ApplyState;
    namespace: string | null;
    cursor: string | null;
    requestUrl: string | null;
    reason: string | null;
    retryAfter: string | null;
    polling: boolean;
  };
}

/**
 * `namespace` is the `X-Ferrum-Namespace` the originating mutation carried,
 * or `null` when that mutation was fleet-global. The poll is a follow-up of
 * that mutation and must keep its binding rather than pick a namespace of
 * its own.
 */
type ApplyStatusFetcher = (
  epoch: string,
  sequence: string,
  waitMs: number,
  namespace: string | null,
) => Promise<ApplyStatusResponse>;

const NAMESPACE_HEADER = "x-ferrum-namespace";

const IDLE_APPLY: GatewayMetadataSnapshot["apply"] = {
  state: "idle",
  namespace: null,
  cursor: null,
  requestUrl: null,
  reason: null,
  retryAfter: null,
  polling: false,
};

let snapshot: GatewayMetadataSnapshot = {
  cachedResponse: null,
  etag: null,
  cacheControl: null,
  contentDisposition: null,
  apply: IDLE_APPLY,
};
let statusFetcher: ApplyStatusFetcher | undefined;
let pollGeneration = 0;
let latestMutationOrder = 0;
let sessionGeneration = 0;

export interface GatewayRequestIdentity {
  session: number;
  mutationOrder?: number;
}

export const GATEWAY_REQUEST_IDENTITY = "ferrum.gatewayRequestIdentity";
const listeners = new Set<() => void>();

export function getGatewayMetadataSnapshot(): GatewayMetadataSnapshot {
  return snapshot;
}

export function subscribeGatewayMetadata(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: GatewayMetadataSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function parseConfigCursor(value: string | null): ConfigCursor | null {
  if (!value || !/^\d+:\d+$/.test(value)) return null;
  const [epoch, sequence] = value.split(":");
  if (uint64(epoch) === null || uint64(sequence) === null) return null;
  return { raw: value, epoch, sequence };
}

export function setApplyStatusFetcher(fetcher?: ApplyStatusFetcher): void {
  statusFetcher = fetcher;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** Allocate ownership before headers can race; never cancel a known commit here. */
export function beginGatewayRequest(request: Request): GatewayRequestIdentity {
  const identity: GatewayRequestIdentity = { session: sessionGeneration };
  if (!request.url.includes("/api/proxy/") || !isMutation(request.method)) return identity;
  latestMutationOrder += 1;
  if (["applied", "succeeded", "nothing_applied"].includes(snapshot.apply.state)) {
    publish({ ...snapshot, apply: IDLE_APPLY });
  }
  return { ...identity, mutationOrder: latestMutationOrder };
}

function uint64(value: unknown): string | null {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) return null;
  return BigInt(text).toString();
}

function validApplyStatus(value: unknown, cursor: ConfigCursor): value is ApplyStatusResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.state !== "string" || !["applied", "pending", "rejected", "unverifiable"].includes(result.state)) return false;
  const epoch = uint64(result.topology_epoch);
  const sequence = uint64(result.sequence);
  const acceptedEpoch = uint64(result.accepted_topology_epoch);
  const acceptedSequence = uint64(result.accepted_sequence);
  if (epoch === null || sequence === null || acceptedEpoch === null || acceptedSequence === null) return false;
  if (epoch !== uint64(cursor.epoch) || sequence !== uint64(cursor.sequence)) return false;
  return result.state !== "applied" || (acceptedEpoch === epoch && BigInt(acceptedSequence) >= BigInt(sequence));
}

function responseReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}

function isCommittedNotLive(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).applied === false,
  );
}

async function pollApplyStatus(
  cursor: ConfigCursor,
  generation: number,
  namespace: string | null,
): Promise<void> {
  if (!statusFetcher) {
    if (generation === pollGeneration) {
      publish({
        ...snapshot,
        apply: { ...snapshot.apply, state: "unverifiable", polling: false },
      });
    }
    return;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (generation !== pollGeneration) return;
    try {
      const result = await statusFetcher(
        cursor.epoch,
        cursor.sequence,
        APPLY_WAIT_MS,
        namespace,
      );
      if (generation !== pollGeneration) return;
      if (!validApplyStatus(result, cursor)) {
        publish({ ...snapshot, apply: { ...snapshot.apply, state: "unverifiable", reason: "invalid_apply_status", polling: false } });
        return;
      }
      if (result.state === "pending") continue;
      publish({
        ...snapshot,
        apply: {
          ...snapshot.apply,
          state: result.state,
          reason:
            result.state === "rejected"
              ? "runtime_rejected"
              : result.state === "unverifiable"
                ? "topology_changed_or_unknown"
                : null,
          polling: false,
        },
      });
      return;
    } catch {
      if (attempt < 2) continue;
      if (generation === pollGeneration) {
        publish({
          ...snapshot,
          apply: {
            ...snapshot.apply,
            state: "unverifiable",
            reason: "apply_status_unavailable",
            polling: false,
          },
        });
      }
      return;
    }
  }

  if (generation === pollGeneration) {
    publish({ ...snapshot, apply: { ...snapshot.apply, polling: false } });
  }
}

/** Observe response metadata without ever replaying the originating request. */
export async function observeGatewayResponse(
  request: Request,
  response: Response,
  identity?: GatewayRequestIdentity,
): Promise<void> {
  if (!request.url.includes("/api/proxy/")) return;
  const owner = identity ?? beginGatewayRequest(request);
  if (owner.session !== sessionGeneration) return;

  const dataSource = response.headers.get("x-data-source");
  const cachedResponse = dataSource === "cached"
    ? { url: request.url, observedAt: new Date().toISOString() }
    : snapshot.cachedResponse?.url === request.url
      ? null
      : snapshot.cachedResponse;

  let next: GatewayMetadataSnapshot = {
    ...snapshot,
    cachedResponse,
    etag: response.headers.get("etag"),
    cacheControl: response.headers.get("cache-control"),
    contentDisposition: response.headers.get("content-disposition"),
  };

  if (!isMutation(request.method)) {
    publish(next);
    return;
  }

  const order = owner.mutationOrder;
  if (owner.session !== sessionGeneration || order !== latestMutationOrder) return;
  const namespace = request.headers.get(NAMESPACE_HEADER);

  const cursor = parseConfigCursor(
    response.headers.get("x-ferrum-config-cursor"),
  );
  const retryAfter = response.headers.get("retry-after");
  let body: unknown;
  if (response.status === 503) {
    body = await response.clone().json().catch(() => undefined);
  }
  // A newer mutation may have superseded this response during the body read.
  // Discard every stale classification before publishing or starting a poll.
  if (owner.session !== sessionGeneration || order !== latestMutationOrder) return;
  // Body reads and status polls may both have completed since this observer
  // started. Base publication on the current monitor, never its earlier copy.
  next = { ...snapshot, cachedResponse, etag: next.etag, cacheControl: next.cacheControl, contentDisposition: next.contentDisposition };
  const committed = response.ok || (response.status === 503 && (cursor !== null || isCommittedNotLive(body)));
  if (!committed && ["pending", "rejected", "unverifiable"].includes(snapshot.apply.state)) {
    publish(next);
    return;
  }
  if (committed) pollGeneration += 1;
  const generation = pollGeneration;

  if (response.status === 503 && (cursor || isCommittedNotLive(body))) {
    next = {
      ...next,
      apply: {
        namespace,
        state: cursor ? "pending" : "unverifiable",
        cursor: cursor?.raw ?? null,
        requestUrl: request.url,
        reason: responseReason(body),
        retryAfter: null,
        polling: Boolean(cursor),
      },
    };
  } else if (response.status === 503) {
    next = {
      ...next,
      apply: {
        namespace,
        state: "nothing_applied",
        cursor: null,
        requestUrl: request.url,
        reason: null,
        retryAfter,
        polling: false,
      },
    };
  } else if (response.status === 202) {
    next = {
      ...next,
      apply: {
        namespace,
        state: cursor ? "pending" : "unverifiable",
        cursor: cursor?.raw ?? null,
        requestUrl: request.url,
        reason: cursor ? null : "missing_apply_cursor",
        retryAfter: null,
        polling: Boolean(cursor),
      },
    };
  } else if (response.ok && cursor) {
    next = {
      ...next,
      apply: {
        namespace,
        state: "applied",
        cursor: cursor.raw,
        requestUrl: request.url,
        reason: null,
        retryAfter: null,
        polling: false,
      },
    };
  } else if (response.ok) {
    // A successful mutation can legitimately omit a cursor outside a served
    // database namespace (for example CP/file/DP modes). Retire any older
    // monitor without claiming cursor-proven liveness for this response.
    next = {
      ...next,
      apply: {
        namespace,
        state: "succeeded",
        cursor: null,
        requestUrl: request.url,
        reason: null,
        retryAfter: null,
        polling: false,
      },
    };
  } else {
    // The ordinary error surface owns failures that did not commit.
    next = { ...next, apply: IDLE_APPLY };
  }

  publish(next);
  if (cursor && next.apply.polling) {
    void pollApplyStatus(
      cursor,
      generation,
      namespace,
    );
  }
}

/** Retire metadata when the authenticated authorization boundary changes. */
export function clearGatewayMetadata(): void {
  sessionGeneration += 1;
  pollGeneration += 1;
  latestMutationOrder += 1;
  publish({
    cachedResponse: null,
    etag: null,
    cacheControl: null,
    contentDisposition: null,
    apply: IDLE_APPLY,
  });
}

/** Test-only reset, including the configured status transport. */
export function resetGatewayMetadata(): void {
  clearGatewayMetadata();
  statusFetcher = undefined;
}
