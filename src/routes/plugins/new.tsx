/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Plugin Config page                         */
/* ------------------------------------------------------------------ */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCreatePluginConfig, useAvailablePlugins } from "@/hooks/usePlugins";
import { useUpdateProxy, useProxies } from "@/hooks/useProxies";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import type { PluginFormDefaults } from "@/components/forms/PluginConfigForm";
import { getApiErrorMessage } from "@/api/client";
import type { PluginConfigCreate } from "@/api/types";

export default function PluginNewPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const createPlugin = useCreatePluginConfig();
  const updateProxy = useUpdateProxy();
  const { data: proxiesData } = useProxies({ limit: 1000 });
  const { toast } = useToast();
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();

  const handleSubmit = async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
    try {
      const created = await createPlugin.mutateAsync(data);

      // For proxy_group, associate selected proxies with this plugin
      if (proxyGroupIds && proxyGroupIds.length > 0 && proxiesData?.data) {
        const associationPromises = proxyGroupIds.map((proxyId) => {
          const proxy = proxiesData.data.find((p) => p.id === proxyId);
          if (!proxy) return Promise.resolve();
          const existingPlugins = proxy.plugins ?? [];
          // Skip if already associated
          if (existingPlugins.some((a) => a.plugin_config_id === created.id)) return Promise.resolve();
          return updateProxy.mutateAsync({
            id: proxyId,
            data: {
              listen_path: proxy.listen_path,
              backend_protocol: proxy.backend_protocol,
              backend_host: proxy.backend_host,
              backend_port: proxy.backend_port,
              plugins: [...existingPlugins, { plugin_config_id: created.id }],
            },
          });
        });
        await Promise.all(associationPromises);
      }

      toast("success", "Plugin configuration created successfully");
      navigate({
        to: "/plugins/$pluginId",
        params: { pluginId: created.id },
      });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(
        err,
        "Failed to create plugin configuration",
      );
      toast("error", message);
    }
  };

  if (pluginsLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Create Plugin</h1>
        <p className="text-text-muted text-sm mt-1">
          Add a new plugin instance and configure its settings.
        </p>
      </div>

      <Card>
        <PluginConfigForm
          onSubmit={handleSubmit}
          isLoading={createPlugin.isPending}
          availablePlugins={availablePlugins ?? []}
          defaults={{
            pluginName: search.plugin ?? undefined,
            scope: search.scope === "proxy_group"
              ? "proxy_group"
              : search.scope === "proxy"
                ? "proxy"
                : search.proxyId
                  ? "proxy"
                  : undefined,
            proxyId: search.proxyId ?? undefined,
          } satisfies PluginFormDefaults}
        />
      </Card>
    </div>
  );
}
