/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health & Metrics API functions                   */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";
import type { AdminMetrics, HealthResponse } from "./types";

export async function getHealth(scope: NamespaceScope): Promise<HealthResponse> {
  return proxyApi.get("health", scoped(scope)).json<HealthResponse>();
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
