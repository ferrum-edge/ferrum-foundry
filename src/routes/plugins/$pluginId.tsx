import { ResourceLabels } from "@/components/shared/ResourceLabels";
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
import { ReadStateNotice } from '@/components/shared/ReadState';
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
import { useCapabilities } from "@/stores/capabilities";
import { WriteAction } from "@/components/shared/CapabilityGate";
import type { PluginConfigCreate } from "@/api/types";
import * as pluginsApi from "@/api/plugins";
import { isStaleResourceError, type StaleResourceDetail } from "@/api/conditionalWrite";
import { StaleWriteDialog } from "@/components/shared/StaleWriteDialog";
import { useEditBaseline } from "@/hooks/useEditBaseline";

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

  const { capabilities } = useCapabilities();
  const capability = capabilities.pluginConfigs;
  const updatePlugin = useUpdatePluginWithMembership();
  const deletePlugin = useDeletePluginWithMembership();
  const detailLive = !deletePlugin.isPending && !deletePlugin.isSuccess;
  const resourceQuery = usePluginConfig(pluginId, detailLive);
  const { data: plugin, isLoading } = resourceQuery;
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();
  const proxiesQuery = useAllProxies();
  const {
    data: allProxies,
    isPending: proxiesPending,
    isError: proxiesError,
  } = proxiesQuery;

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [membershipError, setMembershipError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<StaleResourceDetail | null>(null);
  // Bumped only by an explicit "discard my draft and reload".
  const [formGeneration, setFormGeneration] = useState(0);

  // The configuration this editor opened against, advanced only by an
  // accepted response. The membership plan refuses a save or delete whose
  // plugin no longer matches it. See `docs/concurrent-edits.md`.
  const baseline = useEditBaseline(plugin, pluginsApi.pluginWriteGuard);

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
      if (!capability.allowed) return;
      setMembershipError(null);
      try {
        const updated = await updatePlugin.mutateAsync({
          id: pluginId,
          data,
          proxyIds: data.scope === "proxy_group" ? proxyGroupIds ?? [] : [],
          guard: baseline.current(),
        });
        baseline.adopt(updated);

        toast("success", "Plugin configuration updated successfully");
      } catch (err: unknown) {
        if (isStaleResourceError(err)) {
          setConflict(err.detail);
          return;
        }
        setMembershipError(err);
        const message = await getApiErrorMessage(
          err,
          "Failed to update plugin configuration",
        );
        toast("error", message);
      }
    },
  );

  /** Deliberate restart: drop the draft and reseed the form from the gateway. */
  const handleDiscardAndReload = async () => {
    setConflict(null);
    const refreshed = await resourceQuery.refetch();
    if (refreshed.data) baseline.adopt(refreshed.data);
    setFormGeneration((generation) => generation + 1);
  };

  const handleDelete = session.bind(async () => {
    if (!plugin || !capability.allowed) return;
    setMembershipError(null);
    try {
      // Judged against the configuration this page is displaying — see the
      // proxy detail page.
      await deletePlugin.mutateAsync({
        id: pluginId,
        guard: pluginsApi.pluginWriteGuard(plugin),
      });
      toast("success", "Plugin configuration deleted successfully");
      navigate({ to: "/plugins" });
    } catch (err: unknown) {
      if (isStaleResourceError(err)) {
        setDeleteOpen(false);
        setConflict(err.detail);
        return;
      }
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

  const needsMembership = plugin?.scope === "proxy_group";

  // listAll resolves only after every page succeeds; partial membership must
  // never become the initial selection for a full membership replacement.
  if (isLoading || pluginsLoading || (needsMembership && !allProxies && proxiesPending)) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!plugin || (needsMembership && !allProxies)) {
    if (deletePlugin.isPending || deletePlugin.isSuccess) {
      return null;
    }
    return (
      <div className="max-w-2xl">
        <PluginMembershipRecovery error={membershipError} />
        <Card>
          <p className="text-text-secondary">
            {needsMembership && proxiesError
              ? "Failed to load proxy group membership. Reload to try again."
              : "Failed to load plugin configuration."}
          </p>
          {needsMembership && proxiesError && (
            <ReadStateNotice query={proxiesQuery} label="Proxy group membership" />
          )}
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
      {resourceQuery.isError && (
        <ReadStateNotice query={resourceQuery} label="Plugin configuration" />
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {formatPluginName(plugin.plugin_name)}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">{plugin.id}</p>
        </div>
        <WriteAction verdict={capability}>
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
        </WriteAction>
      </div>

      {needsMembership && proxiesError && (
        <ReadStateNotice query={proxiesQuery} label="Proxy group membership" />
      )}
      {/* Form */}
      <PluginMembershipRecovery error={membershipError} />
      <Card>
        <ResourceLabels labels={plugin.labels} />
        <PluginConfigForm
          key={formGeneration}
          initialData={plugin}
          onSubmit={handleSubmit}
          isLoading={updatePlugin.isPending}
          capability={capability}
          availablePlugins={availablePlugins ?? []}
          initialProxyGroupIds={initialProxyGroupIds}
          initialProxyGroupIdsLoaded={!needsMembership || allProxies !== undefined}
        />
      </Card>

      {/* Refused concurrent-edit save or delete */}
      <StaleWriteDialog
        conflict={conflict}
        onKeepEditing={() => setConflict(null)}
        onDiscardAndReload={handleDiscardAndReload}
      />

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
