/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config detail / edit page                  */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  usePluginConfig,
  useUpdatePluginWithMembership,
  useDeletePluginWithMembership,
  useAvailablePlugins,
} from "@/hooks/usePlugins";
import { useAllProxies } from "@/hooks/useProxies";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import { PluginMembershipRecovery } from "@/components/forms/PluginMembershipRecovery";
import { getApiErrorMessage } from "@/api/client";
import { formatPluginName } from "@/lib/pluginConfigDefaults";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import type { PluginConfigCreate } from "@/api/types";

/**
 * The route component survives a namespace switch; `PluginEditor` is keyed on
 * `{ namespace, pluginId }` so the form, the membership recovery notice, and
 * the delete confirmation remount against the newly selected tenant (see
 * `src/lib/editorIdentity.ts`).
 */
export default function PluginDetailPage() {
  const { pluginId } = useParams({ strict: false }) as { pluginId: string };
  const { toast } = useToast();
  const session = useEditorIdentity(pluginId, {
    onStale: () => toast("warning", STALE_EDITOR_MESSAGE),
  });

  return <PluginEditor key={session.key} session={session} />;
}

function PluginEditor({ session }: { session: EditorSession }) {
  const pluginId = session.identity.resourceId;
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: plugin, isLoading, isError } = usePluginConfig(pluginId);
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();
  const { data: allProxies } = useAllProxies();
  const updatePlugin = useUpdatePluginWithMembership();
  const deletePlugin = useDeletePluginWithMembership();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [membershipError, setMembershipError] = useState<unknown>(null);

  // Compute which proxies currently reference this plugin (for proxy_group)
  const initialProxyGroupIds = useMemo(() => {
    if (!allProxies || !plugin || plugin.scope !== "proxy_group") return [];
    return allProxies
      .filter((p) => p.plugins?.some((a) => a.plugin_config_id === pluginId))
      .map((p) => p.id);
  }, [allProxies, plugin, pluginId]);

  /* ---------- Handlers ---------- */

  const handleSubmit = session.bind(
    async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
      setMembershipError(null);
      try {
        await updatePlugin.mutateAsync({
          id: pluginId,
          data,
          proxyIds: data.scope === "proxy_group" ? proxyGroupIds ?? [] : [],
        });

        toast("success", "Plugin configuration updated successfully");
      } catch (err: unknown) {
        setMembershipError(err);
        const message = await getApiErrorMessage(
          err,
          "Failed to update plugin configuration",
        );
        toast("error", message);
      }
    },
  );

  const handleDelete = session.bind(async () => {
    setMembershipError(null);
    try {
      await deletePlugin.mutateAsync(pluginId);
      toast("success", "Plugin configuration deleted successfully");
      navigate({ to: "/plugins" });
    } catch (err: unknown) {
      setMembershipError(err);
      setDeleteOpen(false);
      const message = await getApiErrorMessage(
        err,
        "Failed to delete plugin configuration",
      );
      toast("error", message);
    }
  });

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
        <PluginMembershipRecovery error={membershipError} />
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
            {formatPluginName(plugin.plugin_name)}
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
      <PluginMembershipRecovery error={membershipError} />
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
