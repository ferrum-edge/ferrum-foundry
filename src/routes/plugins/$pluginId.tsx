/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config detail / edit page                  */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  usePluginConfig,
  useUpdatePluginConfig,
  useDeletePluginConfig,
  useAvailablePlugins,
} from "@/hooks/usePlugins";
import { useProxies, useUpdateProxy } from "@/hooks/useProxies";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import { getApiErrorMessage } from "@/api/client";
import type { PluginConfigCreate } from "@/api/types";

export default function PluginDetailPage() {
  const { pluginId } = useParams({ strict: false }) as { pluginId: string };
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: plugin, isLoading, isError } = usePluginConfig(pluginId);
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();
  const { data: proxiesData } = useProxies({ limit: 1000 });
  const updatePlugin = useUpdatePluginConfig();
  const updateProxy = useUpdateProxy();
  const deletePlugin = useDeletePluginConfig();

  const [deleteOpen, setDeleteOpen] = useState(false);

  // Compute which proxies currently reference this plugin (for proxy_group)
  const initialProxyGroupIds = useMemo(() => {
    if (!proxiesData?.data || !plugin || plugin.scope !== "proxy_group") return [];
    return proxiesData.data
      .filter((p) => p.plugins?.some((a) => a.plugin_config_id === pluginId))
      .map((p) => p.id);
  }, [proxiesData?.data, plugin, pluginId]);

  /* ---------- Handlers ---------- */

  const handleSubmit = async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
    try {
      await updatePlugin.mutateAsync({ id: pluginId, data });

      // Sync proxy associations for proxy_group scope
      if (data.scope === "proxy_group" && proxyGroupIds && proxiesData?.data) {
        const currentIds = new Set(initialProxyGroupIds);
        const desiredIds = new Set(proxyGroupIds);

        // Add association to newly selected proxies
        const toAdd = proxyGroupIds.filter((id) => !currentIds.has(id));
        // Remove association from de-selected proxies
        const toRemove = initialProxyGroupIds.filter((id) => !desiredIds.has(id));

        const promises = [
          ...toAdd.map((proxyId) => {
            const proxy = proxiesData.data.find((p) => p.id === proxyId);
            if (!proxy) return Promise.resolve();
            return updateProxy.mutateAsync({
              id: proxyId,
              data: {
                listen_path: proxy.listen_path,
                backend_protocol: proxy.backend_protocol,
                backend_host: proxy.backend_host,
                backend_port: proxy.backend_port,
                plugins: [...(proxy.plugins ?? []), { plugin_config_id: pluginId }],
              },
            });
          }),
          ...toRemove.map((proxyId) => {
            const proxy = proxiesData.data.find((p) => p.id === proxyId);
            if (!proxy) return Promise.resolve();
            return updateProxy.mutateAsync({
              id: proxyId,
              data: {
                listen_path: proxy.listen_path,
                backend_protocol: proxy.backend_protocol,
                backend_host: proxy.backend_host,
                backend_port: proxy.backend_port,
                plugins: (proxy.plugins ?? []).filter((a) => a.plugin_config_id !== pluginId),
              },
            });
          }),
        ];

        if (promises.length > 0) await Promise.all(promises);
      }

      toast("success", "Plugin configuration updated successfully");
    } catch (err: unknown) {
      const message = await getApiErrorMessage(
        err,
        "Failed to update plugin configuration",
      );
      toast("error", message);
    }
  };

  const handleDelete = async () => {
    try {
      await deletePlugin.mutateAsync(pluginId);
      toast("success", "Plugin configuration deleted successfully");
      navigate({ to: "/plugins" });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(
        err,
        "Failed to delete plugin configuration",
      );
      toast("error", message);
    }
  };

  /* ---------- Loading / Error states ---------- */

  if (isLoading || pluginsLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (isError || !plugin) {
    return (
      <div className="max-w-2xl">
        <Card>
          <p className="text-text-secondary">
            Failed to load plugin configuration.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => navigate({ to: "/plugins" })}
          >
            Back to Plugins
          </Button>
        </Card>
      </div>
    );
  }

  /* ---------- Render ---------- */

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {plugin.plugin_name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">{plugin.id}</p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
          Delete
        </Button>
      </div>

      {/* Form */}
      <Card>
        <PluginConfigForm
          initialData={plugin}
          onSubmit={handleSubmit}
          isLoading={updatePlugin.isPending}
          availablePlugins={availablePlugins ?? []}
          initialProxyGroupIds={initialProxyGroupIds}
        />
      </Card>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Plugin Configuration"
        description={`Are you sure you want to delete the "${plugin.plugin_name}" plugin configuration? This action cannot be undone.`}
        confirmLabel="Delete Plugin"
        variant="danger"
        onConfirm={handleDelete}
        loading={deletePlugin.isPending}
      />
    </div>
  );
}
