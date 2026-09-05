/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Plugins                 */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation to it. Membership plans bind their listing,   */
/*  preflight, apply, and rollback requests through                   */
/*  `bindPluginMembership(scope)`, so a switch mid-plan cannot split  */
/*  the plan (or its compensation) across namespaces.                 */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as plugins from "@/api/plugins";
import type { PaginationParams, PluginConfigCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import {
  bindPluginMembership,
  createPluginWithMembership,
  deletePluginWithMembership,
  updatePluginWithMembership,
} from "@/lib/pluginMembership";

export function useAvailablePlugins() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["plugins", "available", scope.namespace],
    queryFn: () => plugins.listAvailable(scope),
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
    queryFn: () => plugins.listConfigs(scope, params),
    enabled,
  });
}

export function useAllPluginConfigs(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfigs", scope.namespace, "all"],
    queryFn: () => plugins.listAllConfigs(scope),
    enabled,
  });
}

export function usePluginConfig(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfig", scope.namespace, id],
    queryFn: () => plugins.getConfig(scope, id),
    enabled: !!id,
  });
}

export function useCreatePluginConfig() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (data: PluginConfigCreate) => plugins.createConfig(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useCreatePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({
      data,
      proxyIds = [],
    }: {
      data: PluginConfigCreate;
      proxyIds?: string[];
    }) => createPluginWithMembership(data, proxyIds, bindPluginMembership(scope)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useUpdatePluginConfig() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PluginConfigCreate }) =>
      plugins.updateConfig(scope, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
    },
  });
}

export function useUpdatePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({
      id,
      data,
      proxyIds = [],
    }: {
      id: string;
      data: PluginConfigCreate;
      proxyIds?: string[];
    }) =>
      updatePluginWithMembership(id, data, proxyIds, bindPluginMembership(scope)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useDeletePluginConfig() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (id: string) => plugins.removeConfig(scope, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useDeletePluginWithMembership() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (id: string) =>
      deletePluginWithMembership(id, bindPluginMembership(scope)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}
