/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Health & Metrics        */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import { useQuery } from "@tanstack/react-query";
import * as metrics from "@/api/metrics";
import { useNamespace } from "@/stores/namespace";

/** 5 minutes in ms. */
const FIVE_MINUTES = 300_000;

export function useHealth() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["health", scope.namespace],
    queryFn: () => metrics.getHealth(queryScope(scope)),
    staleTime: 30_000,
  });
}

export function useAdminMetrics(refreshInterval: number = FIVE_MINUTES) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["adminMetrics", scope.namespace],
    queryFn: () => metrics.getAdminMetrics(queryScope(scope)),
    refetchInterval: refreshInterval > 0 ? refreshInterval : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: refreshInterval > 0,
  });
}

export function usePrometheusMetrics(refreshInterval?: number) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["prometheusMetrics", scope.namespace],
    queryFn: () => metrics.getPrometheusMetrics(queryScope(scope)),
    refetchInterval: refreshInterval !== undefined && refreshInterval > 0 ? refreshInterval : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: refreshInterval === undefined ? undefined : refreshInterval > 0,
  });
}
