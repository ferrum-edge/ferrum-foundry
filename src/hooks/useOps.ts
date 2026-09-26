/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for gateway operations      */
/*                                                                    */
/*  Process-level surfaces (overload, runtime, cluster, capabilities) */
/*  are not tenant data, so their cache keys stay namespace-free; the */
/*  BFF still authorizes each request against the caller's namespace  */
/*  grants, so every fetch is bound to the scope current when it      */
/*  started. Tenant surfaces (audit, backup, restore) key on it too.  */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import { classifyUnobservedOutcome } from "@/api/mutationOutcome";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as ops from "@/api/ops";
import { useNamespace } from "@/stores/namespace";
import { retireCascade, type CascadeKind } from "./retireCascade";

export function useOverload(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["overload"],
    queryFn: () => ops.getOverload(queryScope(scope)),
    refetchInterval: refetchInterval ?? 10000,
    refetchOnWindowFocus: refetchInterval === undefined ? undefined : false,
    refetchOnReconnect: refetchInterval === false ? false : undefined,
  });
}

export function useRuntimeMetrics(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["runtimeMetrics"],
    queryFn: () => ops.getRuntimeMetrics(queryScope(scope)),
    refetchInterval: refetchInterval ?? 10000,
    refetchOnWindowFocus: refetchInterval === undefined ? undefined : false,
    refetchOnReconnect: refetchInterval === false ? false : undefined,
  });
}

export function useCharges(refetchInterval?: number | false) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["charges"],
    queryFn: () => ops.getCharges(queryScope(scope)),
    refetchInterval: refetchInterval ?? 30000,
    refetchOnWindowFocus: refetchInterval === undefined ? undefined : false,
    refetchOnReconnect: refetchInterval === false ? false : undefined,
    retry: false,
  });
}

export function useChargesSinkStatus() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["chargesSinkStatus"],
    queryFn: () => ops.getChargesSinkStatus(queryScope(scope)),
    retry: false,
  });
}

export function useClusterStatus() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["cluster"],
    queryFn: () => ops.getClusterStatus(queryScope(scope)),
    refetchInterval: 15000,
  });
}

export function useBackendCapabilities(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["backendCapabilities"],
    queryFn: () => ops.getBackendCapabilities(queryScope(scope)),
    retry: false,
    enabled,
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
    queryFn: () => ops.listAuditEvents(queryScope(scope), params),
  });
}

export function useBackup() {
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (resources?: string[]) => ops.getBackup(scope, resources),
  });
}

/**
 * Every resource-detail kind a restore can replace. Restore swaps the whole of
 * one namespace — proxies, consumers, plugin configurations, upstreams, and
 * API specs — and may re-create an id with different content, so a detail
 * entry cached before it is not the resource the gateway now holds.
 */
const RESTORE_CASCADE: readonly CascadeKind[] = [
  "proxy",
  "upstream",
  "pluginConfig",
  "apiSpecDocument",
  "consumer",
];

/** Rollback outcomes that leave the namespace possibly changed. */
const UNSETTLED_ROLLBACK = new Set<ops.RestoreRollbackOutcome>(["incomplete", "unknown_outcome"]);

export function useRestore() {
  const qc = useQueryClient();
  // Detail editors seed once per identity (`src/lib/editorIdentity.ts`), so an
  // invalidated-but-cached detail would still seed the next editor with
  // pre-restore content (#446). The restored namespace's detail entries are
  // retired instead — by prefix, since the ids a backup replaced are not all
  // known client-side, and only under the namespace the restore was issued
  // for. Everything else is invalidated so it reads back current state.
  const settle = (namespace: string) => {
    retireCascade(qc, namespace, RESTORE_CASCADE);
    qc.invalidateQueries();
  };
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
    onError: (error, { namespace }) => {
      // The durable configuration changed even when runtime application is
      // pending. An unobservable outcome, or a failure whose rollback did not
      // complete, may have changed it too: none of those makes the cached
      // detail authoritative, so they settle exactly like a success and the
      // operator reads back real state.
      const rollback = ops.getRestoreFailure(error)?.rollback;
      if (
        ops.getRestoreCommitted(error) ||
        classifyUnobservedOutcome(error) ||
        (rollback !== undefined && UNSETTLED_ROLLBACK.has(rollback))
      ) {
        settle(namespace);
      }
    },
    onSuccess: (_result, { namespace }) => {
      settle(namespace);
    },
  });
}
