/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Plugins                 */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation to it. Membership plans bind their listing,   */
/*  preflight, apply, and rollback requests through                   */
/*  `bindPluginMembership(scope)`, so a switch mid-plan cannot split  */
/*  the plan (or its compensation) across namespaces.                 */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as plugins from "@/api/plugins";
import { SUMMARY_SCAN_BUDGET } from "@/api/pagination";
import type { WriteGuard } from "@/api/conditionalWrite";
import type { PaginationParams, PluginConfig, PluginConfigCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import {
  bindPluginMembership,
  createPluginWithMembership,
  deletePluginWithMembership,
  updatePluginWithMembership,
} from "@/lib/pluginMembership";
import { retireDeletedDetail } from "./retireDeletedDetail";

export function useAvailablePlugins() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["plugins", "available", scope.namespace],
    queryFn: () => plugins.listAvailable(queryScope(scope)),
  });
}

export function usePluginConfigs(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "pluginConfigs",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: ({ signal }) =>
      plugins.listConfigs(queryScope(scope), params, signal),
    enabled,
  });
}

/**
 * The complete plugin-configuration collection.
 *
 * Only for conclusions that are wrong if partial — the effective-policy graph
 * and membership. Pass `enabled` to defer it until the view that needs it is
 * actually requested: opening a proxy editor should not traverse the whole
 * namespace before the operator asks a policy question. A summary count uses
 * `useBoundedPluginConfigs` instead.
 */
export function useAllPluginConfigs(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfigs", scope.namespace, "all"],
    queryFn: ({ signal }) => plugins.listAllConfigs(queryScope(scope), signal),
    enabled,
  });
}

/**
 * Plugin configurations up to the summary budget.
 *
 * `complete: false` means the namespace is larger than a list column is
 * willing to traverse. The caller must then present the count as unavailable
 * at this size — never as a smaller number, which would under-report what runs
 * on a proxy.
 */
export function useBoundedPluginConfigs(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfigs", scope.namespace, "bounded", SUMMARY_SCAN_BUDGET],
    queryFn: ({ signal }) =>
      plugins.listBoundedConfigs(queryScope(scope), signal),
    enabled,
  });
}

/**
 * The proxy-scoped configurations whose `proxy_id` is this proxy, attached or
 * not (`GET /plugins/config?proxy_id=`). Bounded by that proxy's
 * configurations, not the namespace; it is not an effective-policy answer.
 * The key sits under `["pluginConfigs", namespace]`, so every plugin and
 * membership mutation that invalidates the lists refreshes it too.
 */
export function useProxyPluginConfigs(proxyId: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfigs", scope.namespace, "proxy", proxyId],
    queryFn: ({ signal }) =>
      plugins.listConfigsForProxy(queryScope(scope), proxyId, signal),
    enabled: enabled && !!proxyId,
  });
}

export function usePluginConfig(id: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfig", scope.namespace, id],
    queryFn: () => plugins.getConfig(queryScope(scope), id),
    enabled: enabled && !!id,
  });
}

export function useCreatePluginConfig() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted secret variables as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: (data: PluginConfigCreate) => plugins.createConfig(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

/**
 * A membership plan rewrites `plugins` on proxies (and Edge appends the
 * association itself on a proxy-scoped create), so the cached proxy detail is
 * as stale as the list. Run on settle: a plan that failed part-way may still
 * have written some proxies. Editors seed once and never compare `plugins`,
 * so refreshing the detail cannot disturb an open draft.
 */
function invalidateMembership(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
  qc.invalidateQueries({ queryKey: ["proxies"] });
  qc.invalidateQueries({ queryKey: ["proxy"] });
}

export function useCreatePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted secret variables as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: ({
      data,
      proxyIds = [],
    }: {
      data: PluginConfigCreate;
      proxyIds?: string[];
    }) => createPluginWithMembership(data, proxyIds, bindPluginMembership(scope)),
    onSettled: () => invalidateMembership(qc),
  });
}

export function useUpdatePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted secret variables as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: ({
      id,
      data,
      proxyIds = [],
      guard,
    }: {
      id: string;
      data: PluginConfigCreate;
      proxyIds?: string[];
      guard: WriteGuard<PluginConfig | PluginConfigCreate> | null;
    }) =>
      updatePluginWithMembership(id, data, proxyIds, bindPluginMembership(scope), guard),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
      invalidateMembership(qc);
    },
  });
}

export function useDeletePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async ({
      id,
      guard,
    }: {
      id: string;
      guard: WriteGuard<PluginConfig | PluginConfigCreate> | null;
    }) => {
      await deletePluginWithMembership(id, bindPluginMembership(scope), guard);
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, [
        "pluginConfig",
        retired.namespace,
        retired.id,
      ]);
    },
    onSettled: () => invalidateMembership(qc),
  });
}
