/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health & Metrics API functions                   */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type { AdminMetrics, HealthResponse } from "./types";

export async function getHealth(): Promise<HealthResponse> {
  return proxyApi.get("health").json<HealthResponse>();
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  return proxyApi.get("admin/metrics").json<AdminMetrics>();
}

export async function getPrometheusMetrics(): Promise<string> {
  return proxyApi.get("metrics").text();
}
