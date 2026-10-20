import { ResourceLabels } from "@/components/shared/ResourceLabels";
/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config detail / edit page                  */
/* ------------------------------------------------------------------ */

import { useState, useMemo, useRef } from "react";
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
import { PageHeader } from "@/components/shared/PageHeader";
import { TrashIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import { PluginMembershipRecovery } from "@/components/forms/PluginMembershipRecovery";
import { MaskedSecretRefusal } from "@/components/shared/MaskedSecretRefusal";
import { maskedPlaceholderRefusal } from "@/api/maskedSecrets";
import { committedWriteMessage, getApiErrorMessage } from "@/api/client";
import { formatPluginName } from "@/lib/pluginConfigDefaults";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import {
  observedMembership,
  PluginMembershipChangedError,
  PluginSavedUnverifiedError,
} from "@/lib/pluginMembership";
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

  const { capabilities, facts } = useCapabilities();
  const capability = capabilities.pluginConfigs;
  const updatePlugin = useUpdatePluginWithMembership();
  const deletePlugin = useDeletePluginWithMembership();
  const detailLive = !deletePlugin.isPending && !deletePlugin.isSuccess;
  const resourceQuery = usePluginConfig(pluginId, detailLive);
  const { data: plugin, isLoading } = resourceQuery;
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();
  // Only a proxy-group plugin's membership needs the whole proxy collection;
  // global and proxy-scoped plugins must not pay for that traversal.
  const proxiesQuery = useAllProxies(plugin?.scope === "proxy_group");
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

  // The membership the form was seeded with for this generation: what the
  // operator saw. A save or delete sends it as `expected_proxy_ids` (#630),
  // so a proxy attached since — even one a background refetch has picked up
  // without reseeding the form — refuses the write instead of being silently
  // detached. Like the baseline, only an accepted save or an explicit reload
  // (a new form generation) moves it.
  const membershipSeen = useRef<{ generation: number; ids: readonly string[] } | null>(null);
  const membershipReady =
    plugin !== undefined && (plugin.scope !== "proxy_group" || allProxies !== undefined);
  if (plugin && membershipReady && membershipSeen.current?.generation !== formGeneration) {
    membershipSeen.current = {
      generation: formGeneration,
      ids: observedMembership(plugin, initialProxyGroupIds),
    };
  }

  /* ---------- Handlers ---------- */

  const handleSubmit = session.bind(
    async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
      const seen = membershipSeen.current;
      if (!capability.allowed || !seen) return;
      setMembershipError(null);
      const proxyIds = data.scope === "proxy_group" ? proxyGroupIds ?? [] : [];
      try {
        const updated = await updatePlugin.mutateAsync({
          id: pluginId,
          data,
          proxyIds,
          guard: baseline.current(),
          observedProxyIds: seen.ids,
        });
        baseline.adopt(updated);
        // The form now shows the membership this save established.
        membershipSeen.current = {
          generation: seen.generation,
          ids: observedMembership(updated, proxyIds),
        };

        toast("success", "Plugin configuration updated successfully");
      } catch (err: unknown) {
        if (isStaleResourceError(err)) {
          setConflict(err.detail);
          return;
        }
        if (err instanceof PluginSavedUnverifiedError) {
          // Saved on the gateway (#610). The form is not replaced
          // automatically, since the operator may have kept editing; the
          // recovery panel offers an explicit reload of what was saved.
          setMembershipError(err);
          toast("warning", `${err.message} Reload the saved configuration before saving again.`);
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

  /**
   * Reload after a saved-but-unverified move (#610), or a save or delete
   * refused because the membership changed since the form was seeded (#630);
   * the new form generation reseeds the membership snapshot too. Only fresh reads are
   * adopted: the plugin, and for a group its complete proxy membership, which
   * the form seeds once. If either read fails, the draft and the recovery
   * report stay as they are.
   */
  const handleReloadSaved = async () => {
    const refreshed = await resourceQuery.refetch();
    if (refreshed.isError || refreshed.data === undefined) {
      toast("error", "Could not re-read the plugin; your form was kept. Try again.");
      return;
    }
    if (refreshed.data.scope === "proxy_group") {
      const members = await proxiesQuery.refetch();
      if (members.isError || members.data === undefined) {
        toast("error", "Could not re-read the plugin's proxies; your form was kept. Try again.");
        return;
      }
    }
    baseline.adopt(refreshed.data);
    setFormGeneration((generation) => generation + 1);
    setMembershipError(null);
  };

  const handleDelete = session.bind(async () => {
    const seen = membershipSeen.current;
    if (!plugin || !capability.allowed || !seen) return;
    setMembershipError(null);
    try {
      // Judged against the configuration this page is displaying — see the
      // proxy detail page — and the membership its form shows.
      const deleted = await deletePlugin.mutateAsync({
        id: pluginId,
        guard: pluginsApi.pluginDeleteGuard(plugin),
        observedProxyIds: seen.ids,
      });
      if (deleted.committed) {
        toast(
          "warning",
          committedWriteMessage("Plugin configuration deleted", deleted.committed),
        );
      } else {
        toast("success", "Plugin configuration deleted successfully");
      }
      // The delete reconciled its own resource either way; only the
      // editor still on screen may leave for the collection.
      if (session.isCurrent()) navigate({ to: "/plugins" });
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
      <PageHeader
        title={formatPluginName(plugin.plugin_name)}
        meta={plugin.id}
        breadcrumbs={[
          { label: "Plugins", to: "/plugins" },
          { label: formatPluginName(plugin.plugin_name) },
        ]}
        actions={
          <WriteAction verdict={capability}>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              <TrashIcon />
              Delete
            </Button>
          </WriteAction>
        }
      />

      {needsMembership && proxiesError && (
        <ReadStateNotice query={proxiesQuery} label="Proxy group membership" />
      )}
      {/* Form */}
      {/* A masked-placeholder refusal is the plugin write itself being
          refused, before anything changed: list its fields once instead of
          repeating Edge's message as a recovery report. */}
      {maskedPlaceholderRefusal(membershipError) ? (
        <MaskedSecretRefusal error={membershipError} />
      ) : (
        <PluginMembershipRecovery error={membershipError} />
      )}
      {membershipError instanceof PluginSavedUnverifiedError && (
        <Button
          variant="secondary"
          onClick={() => void handleReloadSaved()}
        >
          Reload saved configuration
        </Button>
      )}
      {membershipError instanceof PluginMembershipChangedError && (
        <Button
          variant="secondary"
          onClick={() => void handleReloadSaved()}
        >
          Reload current membership (discards your draft)
        </Button>
      )}
      <Card>
        <ResourceLabels labels={plugin.labels} />
        <PluginConfigForm
          key={formGeneration}
          initialData={plugin}
          onSubmit={handleSubmit}
          isLoading={updatePlugin.isPending}
          capability={capability}
          role={facts.role}
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
