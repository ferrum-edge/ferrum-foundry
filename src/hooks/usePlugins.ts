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

export function useAvailablePlugins() {
  return useQuery({
    queryKey: ["plugins", "available"],
    queryFn: () => plugins.listAvailable(),
  });
}

export function usePluginConfigs(params: PaginationParams = {}) {
  return useQuery({
    queryKey: [
      "pluginConfigs",
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: () => plugins.listConfigs(params),
  });
}

export function usePluginConfig(id: string) {
  return useQuery({
    queryKey: ["pluginConfig", id],
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

export function useUpdatePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PluginConfigCreate }) =>
      plugins.updateConfig(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["pluginConfig", variables.id] });
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
