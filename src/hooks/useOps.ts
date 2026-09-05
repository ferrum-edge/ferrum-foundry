/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for gateway operations      */
/*                                                                    */
/*  Process-level surfaces (overload, runtime, cluster, capabilities) */
/*  are not tenant data, so their cache keys stay namespace-free; the */
/*  BFF still authorizes each request against the caller's namespace  */
/*  grants, so every fetch is bound to the scope current when it      */
/*  started. Tenant surfaces (audit, backup, restore) key on it too.  */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as ops from "@/api/ops";
import { useNamespace } from "@/stores/namespace";

export function useOverload(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["overload"],
    queryFn: () => ops.getOverload(scope),
    refetchInterval: refetchInterval ?? 10000,
  });
}

export function useRuntimeMetrics(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["runtimeMetrics"],
    queryFn: () => ops.getRuntimeMetrics(scope),
    refetchInterval: refetchInterval ?? 10000,
  });
}

export function useCharges(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["charges"],
    queryFn: () => ops.getCharges(scope),
    refetchInterval: refetchInterval ?? 30000,
    retry: false,
  });
}

export function useChargesSinkStatus() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["chargesSinkStatus"],
    queryFn: () => ops.getChargesSinkStatus(scope),
    retry: false,
  });
}

export function useClusterStatus() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["cluster"],
    queryFn: () => ops.getClusterStatus(scope),
    refetchInterval: 15000,
  });
}

export function useBackendCapabilities() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["backendCapabilities"],
    queryFn: () => ops.getBackendCapabilities(scope),
    retry: false,
  });
}

export function useRefreshBackendCapabilities() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: () => ops.refreshBackendCapabilities(scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backendCapabilities"] });
    },
  });
}

export function useAuditEvents(params: ops.AuditListParams = {}) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["audit", scope.namespace, params],
    queryFn: () => ops.listAuditEvents(scope, params),
  });
}

export function useBackup() {
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (resources?: string[]) => ops.getBackup(scope, resources),
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
      // The namespace the restore dialog pinned when it opened, not the
      // selector's current value.
      namespace: string;
      confirmApiSpecDeletion?: boolean;
    }) => ops.restore({ namespace }, data, { confirmApiSpecDeletion }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}
