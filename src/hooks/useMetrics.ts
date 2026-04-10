/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Health & Metrics        */
/* ------------------------------------------------------------------ */

import { useQuery } from "@tanstack/react-query";
import * as metrics from "@/api/metrics";
import { useNamespace } from "@/stores/namespace";

/** 5 minutes in ms. */
const FIVE_MINUTES = 300_000;

export function useHealth() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["health", ns],
    queryFn: () => metrics.getHealth(),
    staleTime: 30_000,
  });
}

export function useAdminMetrics(refreshInterval: number = FIVE_MINUTES) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["adminMetrics", ns],
    queryFn: () => metrics.getAdminMetrics(),
    refetchInterval: refreshInterval > 0 ? refreshInterval : false,
    refetchOnWindowFocus: false,
  });
}

export function usePrometheusMetrics() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["prometheusMetrics", ns],
    queryFn: () => metrics.getPrometheusMetrics(),
    refetchOnWindowFocus: false,
  });
}
