/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health & Metrics API functions                   */
/* ------------------------------------------------------------------ */

import {
  DEFER_QUERY_ERRORS,
  SILENT_ERRORS,
  proxyApi,
  reportRequestError,
  scoped,
  type NamespaceScope,
} from './client';
import type { AdminMetrics, HealthResponse } from "./types";
import { noteAdminMetricsRequestStart } from "./adminMetricsTiming";
import { isGatewayHealthAnswer } from "../../shared/health-snapshot.js";

export async function getHealth(scope: NamespaceScope): Promise<HealthResponse> {
  let response: Response | undefined;
  try {
    // A documented 503 is an observation; classify its body before reporting errors.
    response = await proxyApi.get(
      'health',
      scoped(scope, {
        throwHttpErrors: false,
        retry: 0,
        context: { [SILENT_ERRORS]: true },
      }),
    );
    const body: unknown = await response.clone().json().catch(() => null);
    if (isGatewayHealthAnswer(response.status, body)) {
      return body as HealthResponse;
    }
    throw new Error(`Health endpoint returned ${response.status} without a valid snapshot`);
  } catch (error) {
    reportRequestError(
      error,
      {
        statusCode: response?.status ?? 0,
        body: response
          ? await response.text().catch(() => '')
          : error instanceof Error
            ? error.message
            : 'Health request failed',
        url: response?.url || '/api/proxy/health',
      },
      Boolean(scope[DEFER_QUERY_ERRORS]),
    );
    throw error;
  }
}

/**
 * `signal` (the Query's) aborts the read when its namespace is abandoned, so
 * a late answer is not cached there. The request-start time is recorded for
 * the request-rate sampler (`adminMetricsRequestStart`).
 */
export async function getAdminMetrics(
  scope: NamespaceScope,
  signal?: AbortSignal,
): Promise<AdminMetrics> {
  const startedAt = Date.now();
  const metrics = await proxyApi
    .get("admin/metrics", scoped(scope, { signal }))
    .json<AdminMetrics>();
  if (metrics && typeof metrics.gateway === "object" && metrics.gateway !== null) {
    noteAdminMetricsRequestStart(metrics.gateway, startedAt);
  }
  return metrics;
}

export async function getPrometheusMetrics(
  scope: NamespaceScope,
): Promise<string> {
  return proxyApi.get("metrics", scoped(scope)).text();
}
