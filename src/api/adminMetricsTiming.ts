/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – when each /admin/metrics read was requested       */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "./types";

/**
 * Request-start time of each `/admin/metrics` response, keyed by its
 * `gateway` object. React Query stamps `dataUpdatedAt` when a response
 * resolves, so a slow request that began before a control plane answered can
 * resolve after it and look newer. The request-rate sampler compares this
 * start time, not the resolve time, against the placeholder it saw.
 * The query disables structural sharing, so every response keeps its own
 * object and therefore its own start time.
 */
const requestStartedAt = new WeakMap<AdminMetrics["gateway"], number>();

export function noteAdminMetricsRequestStart(gateway: AdminMetrics["gateway"], startedAt: number): void {
  requestStartedAt.set(gateway, startedAt);
}

/** When the request that returned `gateway` was sent; `undefined` if unknown. */
export function adminMetricsRequestStart(gateway: AdminMetrics["gateway"]): number | undefined {
  return requestStartedAt.get(gateway);
}
