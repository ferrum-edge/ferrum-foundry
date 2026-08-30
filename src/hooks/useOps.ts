/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for gateway operations      */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as ops from "@/api/ops";
import { useNamespace } from "@/stores/namespace";

export function useOverload(refetchInterval?: number | false) {
  return useQuery({
    queryKey: ["overload"],
    queryFn: () => ops.getOverload(),
    refetchInterval: refetchInterval ?? 10000,
  });
}

export function useRuntimeMetrics(refetchInterval?: number | false) {
  return useQuery({
    queryKey: ["runtimeMetrics"],
    queryFn: () => ops.getRuntimeMetrics(),
    refetchInterval: refetchInterval ?? 10000,
  });
}

export function useCharges(refetchInterval?: number | false) {
  return useQuery({
    queryKey: ["charges"],
    queryFn: () => ops.getCharges(),
    refetchInterval: refetchInterval ?? 30000,
    retry: false,
  });
}

export function useChargesSinkStatus() {
  return useQuery({
    queryKey: ["chargesSinkStatus"],
    queryFn: () => ops.getChargesSinkStatus(),
    retry: false,
  });
}

export function useClusterStatus() {
  return useQuery({
    queryKey: ["cluster"],
    queryFn: () => ops.getClusterStatus(),
    refetchInterval: 15000,
  });
}

export function useBackendCapabilities() {
  return useQuery({
    queryKey: ["backendCapabilities"],
    queryFn: () => ops.getBackendCapabilities(),
    retry: false,
  });
}

export function useRefreshBackendCapabilities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => ops.refreshBackendCapabilities(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backendCapabilities"] });
    },
  });
}

export function useAuditEvents(params: ops.AuditListParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["audit", ns, params],
    queryFn: () => ops.listAuditEvents(params),
  });
}

export function useBackup() {
  return useMutation({
    mutationFn: (resources?: string[]) => ops.getBackup(resources),
  });
}

export function useRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      namespace,
      confirmApiSpecDeletion,
    }: {
      data: Record<string, unknown>;
      namespace: string;
      confirmApiSpecDeletion?: boolean;
    }) => ops.restore(data, { namespace, confirmApiSpecDeletion }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}
