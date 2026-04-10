/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Health & Metrics        */
/* ------------------------------------------------------------------ */

import { useQuery } from "@tanstack/react-query";
import * as metrics from "@/api/metrics";

/** 5 minutes in ms. */
const FIVE_MINUTES = 300_000;

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => metrics.getHealth(),
    staleTime: 30_000,
  });
}

export function useAdminMetrics(refreshInterval: number = FIVE_MINUTES) {
  return useQuery({
    queryKey: ["adminMetrics"],
    queryFn: () => metrics.getAdminMetrics(),
    refetchInterval: refreshInterval,
  });
}

export function usePrometheusMetrics() {
  return useQuery({
    queryKey: ["prometheusMetrics"],
    queryFn: () => metrics.getPrometheusMetrics(),
  });
}
