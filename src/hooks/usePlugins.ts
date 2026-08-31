/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Plugins                 */
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
  createPluginWithMembership,
  deletePluginWithMembership,
  updatePluginWithMembership,
} from "@/lib/pluginMembership";

export function useAvailablePlugins() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["plugins", "available", ns],
    queryFn: () => plugins.listAvailable(),
  });
}

export function usePluginConfigs(params: PaginationParams = {}, enabled = true) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: [
      "pluginConfigs",
      ns,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: () => plugins.listConfigs(params),
    enabled,
  });
}

export function useAllPluginConfigs(enabled = true) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfigs", ns, "all"],
    queryFn: () => plugins.listAllConfigs(),
    enabled,
  });
}

export function usePluginConfig(id: string) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["pluginConfig", ns, id],
    queryFn: () => plugins.getConfig(id),
    enabled: !!id,
  });
}

export function useCreatePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PluginConfigCreate) => plugins.createConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useCreatePluginWithMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      proxyIds = [],
    }: {
      data: PluginConfigCreate;
      proxyIds?: string[];
    }) => createPluginWithMembership(data, proxyIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useUpdatePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PluginConfigCreate }) =>
      plugins.updateConfig(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
    },
  });
}

export function useUpdatePluginWithMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
      proxyIds = [],
    }: {
      id: string;
      data: PluginConfigCreate;
      proxyIds?: string[];
    }) => updatePluginWithMembership(id, data, proxyIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useDeletePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => plugins.removeConfig(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useDeletePluginWithMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePluginWithMembership(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}
