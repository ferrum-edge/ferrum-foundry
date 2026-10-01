/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for the MCP tool catalog     */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryScope } from "@/api/client";
import type { WriteGuard } from "@/api/conditionalWrite";
import * as mcpTools from "@/api/mcpTools";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import type { McpToolPolicyEntry } from "@/lib/mcpToolPolicy";
import { useCapabilities } from "@/stores/capabilities";
import { useNamespace } from "@/stores/namespace";

/**
 * The proxy's cached tool catalog, or `null` when no `mcp_gateway` applies to
 * it. Deferred like the other secondary proxy views: it starts when the
 * Tools tab is opened.
 */
export function useMcpToolCatalog(proxyId: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mcpToolCatalog", scope.namespace, proxyId],
    queryFn: ({ signal }) => mcpTools.getToolCatalog(queryScope(scope), proxyId, signal),
    enabled: enabled && !!proxyId,
  });
}

/**
 * Replace one tool's `policy.tools` entry. The save resends the whole plugin
 * configuration, which may carry secrets, so the mutation keeps nothing
 * cached once its caller is done with it.
 */
export function useUpdateMcpToolPolicy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  const { facts } = useCapabilities();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      pluginId,
      toolName,
      entry,
      guard,
    }: {
      pluginId: string;
      toolName: string;
      entry: McpToolPolicyEntry | null;
      guard: WriteGuard<PluginConfig | PluginConfigCreate> | null;
    }) => mcpTools.updateToolPolicy(scope, pluginId, toolName, entry, guard, facts.role),
    // Settled, not succeeded: a committed-but-not-live answer also changed the
    // stored configuration.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["pluginConfig"] });
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
      qc.invalidateQueries({ queryKey: ["mcpToolCatalog"] });
    },
  });
}
