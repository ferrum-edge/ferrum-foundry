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
    if (
      (response.status === 200 || response.status === 503) &&
      body !== null &&
      typeof body === 'object' &&
      'status' in body &&
      typeof body.status === 'string' &&
      ['ok', 'degraded', 'starting', 'unavailable', 'draining'].includes(body.status) &&
      'ready' in body &&
      typeof body.ready === 'boolean'
    ) {
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

export async function getAdminMetrics(
  scope: NamespaceScope,
): Promise<AdminMetrics> {
  return proxyApi.get("admin/metrics", scoped(scope)).json<AdminMetrics>();
}

export async function getPrometheusMetrics(
  scope: NamespaceScope,
): Promise<string> {
  return proxyApi.get("metrics", scoped(scope)).text();
}
