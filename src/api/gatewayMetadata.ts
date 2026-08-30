export type ApplyState =
  | "idle"
  | "nothing_applied"
  | "pending"
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
    cursor: string | null;
    requestUrl: string | null;
    reason: string | null;
    retryAfter: string | null;
    polling: boolean;
  };
}

type ApplyStatusFetcher = (
  epoch: string,
  sequence: string,
  waitMs: number,
) => Promise<ApplyStatusResponse>;

const IDLE_APPLY: GatewayMetadataSnapshot["apply"] = {
  state: "idle",
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
  return { raw: value, epoch, sequence };
}

export function setApplyStatusFetcher(fetcher?: ApplyStatusFetcher): void {
  statusFetcher = fetcher;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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

async function pollApplyStatus(cursor: ConfigCursor, generation: number): Promise<void> {
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
      const result = await statusFetcher(cursor.epoch, cursor.sequence, 25_000);
      if (generation !== pollGeneration) return;
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
): Promise<void> {
  if (!request.url.includes("/api/proxy/")) return;

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

  // Any newer mutation supersedes an older cursor monitor. This prevents a
  // late status response from overwriting the classification of the request
  // the user most recently made.
  pollGeneration += 1;
  const generation = pollGeneration;

  const cursor = parseConfigCursor(
    response.headers.get("x-ferrum-config-cursor"),
  );
  const retryAfter = response.headers.get("retry-after");
  let body: unknown;
  if (response.status === 503) {
    body = await response.clone().json().catch(() => undefined);
  }

  if (response.status === 503 && isCommittedNotLive(body)) {
    next = {
      ...next,
      apply: {
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
        state: "applied",
        cursor: cursor.raw,
        requestUrl: request.url,
        reason: null,
        retryAfter: null,
        polling: false,
      },
    };
  }

  publish(next);
  if (cursor && next.apply.polling) {
    void pollApplyStatus(cursor, generation);
  }
}

/** Test-only reset; not used by application code. */
export function resetGatewayMetadata(): void {
  pollGeneration += 1;
  statusFetcher = undefined;
  snapshot = {
    cachedResponse: null,
    etag: null,
    cacheControl: null,
    contentDisposition: null,
    apply: IDLE_APPLY,
  };
}
