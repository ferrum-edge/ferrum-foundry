import { ResourceLabels } from "@/components/shared/ResourceLabels";
/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config detail / edit page                  */
/* ------------------------------------------------------------------ */

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { GeneratedResourceNotice } from "@/components/shared/GeneratedResource";
import { isAddressableResourceId } from "@/lib/resourceId";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  pluginConfigKey,
  usePluginConfig,
  useUpdatePluginWithMembership,
  useDeletePluginWithMembership,
  useAvailablePlugins,
} from "@/hooks/usePlugins";
import { allProxiesKey, proxyFirstPageKey, useAllProxies } from "@/hooks/useProxies";
import { useInlineReportedReads } from "@/hooks/inlineReportedReads";
import { useNamespace } from "@/stores/namespace";
import { ReadStateNotice } from '@/components/shared/ReadState';
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/shared/PageHeader";
import { TrashIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm, type PluginFormSeed } from "@/components/forms/PluginConfigForm";
import { PluginMembershipRecovery } from "@/components/forms/PluginMembershipRecovery";
import { MaskedSecretRefusal } from "@/components/shared/MaskedSecretRefusal";
import { maskedPlaceholderRefusal } from "@/api/maskedSecrets";
import { committedWriteMessage, getApiErrorMessage, getCommittedWrite } from "@/api/client";
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
import type { PluginConfig, PluginConfigCreate, PluginScope, Proxy } from "@/api/types";
import * as pluginsApi from "@/api/plugins";
import * as proxiesApi from "@/api/proxies";
import { isStaleResourceError, type StaleResourceDetail } from "@/api/conditionalWrite";
import { StaleWriteDialog } from "@/components/shared/StaleWriteDialog";
import { useEditBaseline } from "@/hooks/useEditBaseline";
import { resourceFingerprint } from "@/lib/resourceBaseline";

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

  if (!isAddressableResourceId(pluginId)) return <GeneratedResourceNotice kind="Plugin configuration" id={pluginId} />;
  return <PluginEditor key={session.key} session={session} />;
}

function PluginEditor({ session }: { session: EditorSession }) {
  const pluginId = session.identity.resourceId;
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { scope } = useNamespace();

  const { capabilities, facts } = useCapabilities();
  const capability = capabilities.pluginConfigs;
  const updatePlugin = useUpdatePluginWithMembership();
  const deletePlugin = useDeletePluginWithMembership();
  const detailLive = !deletePlugin.isPending && !deletePlugin.isSuccess;
  const resourceQuery = usePluginConfig(pluginId, detailLive);
  const { data: plugin, isLoading } = resourceQuery;
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();
  // The scope of the plugin the mounted form was seeded with, or `null` before
  // a form has mounted. Before that, the page waits for everything the form
  // seeds from (a group's complete membership included). After it, a
  // background refetch never takes the form or the conflict dialog off the
  // page, even one that turns the plugin into a group whose membership has
  // not loaded: only a successful explicit reload remounts it.
  const [seededScope, setSeededScope] = useState<PluginScope | null>(null);
  const formSeeded = seededScope !== null;
  // Only a proxy-group plugin's membership needs the whole proxy collection;
  // global and proxy-scoped plugins must not pay for that traversal. Once a
  // form is mounted, the scope it displays decides: a refetch that turns the
  // plugin into a group does not start the background traversal, because the
  // form cannot show that membership anyway (an explicit reload reads it
  // itself), and one that turns it away from a group keeps the membership
  // the form shows refreshed. The one predicate also decides the membership
  // notice, so a failed refresh is always reported beside the form.
  const membershipDisplayed = formSeeded
    ? seededScope === "proxy_group"
    : plugin?.scope === "proxy_group";
  const proxiesQuery = useAllProxies(membershipDisplayed);
  // Once a form is mounted, every background read this page reports inline
  // (the plugin, the picker's first page, the group's membership) stays out
  // of the global error popup, so no popup stacks over the form, a conflict
  // dialog, or a reload's own toast.
  useInlineReportedReads(
    [
      pluginConfigKey(scope.namespace, pluginId),
      proxyFirstPageKey(scope.namespace),
      allProxiesKey(scope.namespace),
    ],
    formSeeded,
  );
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
  // At most one explicit reload at a time. `activeReload` holds the token of
  // the reload in flight; abandoning it (Keep my draft, a newer reload, an
  // editor that moved on) makes its completion apply and report nothing.
  const [reloading, setReloading] = useState(false);
  const reloadCounter = useRef(0);
  const activeReload = useRef<{ token: number; abort: AbortController } | null>(null);
  // Set synchronously when a delete is confirmed, cleared only if it fails:
  // no reload starts or publishes while a delete runs or after it succeeded,
  // so nothing can recreate the detail entry the delete retired.
  const deleting = useRef(false);
  // Set synchronously for a save's whole run (its committed reseed included):
  // a second submit before the pending state renders is refused, and so are
  // a delete or an explicit reload.
  const saving = useRef(false);

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

  // The membership the mounted form was seeded with: what the operator sees.
  // A save or delete sends it as `expected_proxy_ids` (#630), so a proxy
  // attached since — even one a background refetch has picked up without
  // reseeding the form — refuses the write instead of being silently
  // detached. The form reports its seed when it mounts (`onSeeded`), so a read
  // that changes while the page still shows a skeleton (the plugin catalog
  // pending, say) never becomes membership the operator did not see. A
  // remount (an explicit reload) reseeds it; an accepted save advances it.
  // `null` while no form is mounted: nothing is sent.
  const membershipSeen = useRef<readonly string[] | null>(null);
  const handleSeeded = useCallback((seed: PluginFormSeed | null) => {
    membershipSeen.current = seed ? observedMembership(seed.plugin, seed.proxyGroupIds) : null;
    if (seed) setSeededScope(seed.plugin.scope);
  }, []);

  /* ---------- Handlers ---------- */

  const handleSubmit = session.bind(
    async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
      const seen = membershipSeen.current;
      // A reload in flight is about to replace this form; a delete is
      // removing it.
      if (
        !capability.allowed || !seen ||
        activeReload.current || deleting.current || saving.current
      ) return;
      saving.current = true;
      setMembershipError(null);
      const proxyIds = data.scope === "proxy_group" ? proxyGroupIds ?? [] : [];
      try {
        const updated = await updatePlugin.mutateAsync({
          id: pluginId,
          data,
          proxyIds,
          guard: baseline.current(),
          observedProxyIds: seen,
        });
        baseline.adopt(updated);
        // The form now shows the membership this save established.
        membershipSeen.current = observedMembership(updated, proxyIds);
        // A group saved to another scope no longer needs its membership
        // traversal. A save into a group leaves it off until an explicit
        // reload remounts the form with the complete membership.
        if (updated.scope !== "proxy_group") setSeededScope(updated.scope);

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
        const committed = getCommittedWrite(err);
        if (committed) {
          // Saved and its membership plan converged, only not yet live
          // (#674). Reseed form, membership and baseline from fresh reads, as
          // every committed save does (`reseedAfterCommit`), so Save is not
          // refused as a conflict with this very commit.
          const reloaded = await reloadFromGateway();
          // A reload abandoned because this editor moved on (it does not even
          // start then) reports nothing more than the commit itself.
          const unread =
            reloaded === "plugin"
              ? " Foundry could not re-read the plugin; reload it before saving again."
              : reloaded === "membership"
                ? " Foundry could not re-read the plugin's proxies; reload it before saving again."
                : reloaded === "changed"
                  ? " The plugin changed again while Foundry re-read it; reload it before saving again."
                  : "";
          toast("warning", committedWriteMessage("Plugin configuration saved", committed) + unread);
          return;
        }
        setMembershipError(err);
        const message = await getApiErrorMessage(
          err,
          "Failed to update plugin configuration",
        );
        toast("error", message);
      } finally {
        saving.current = false;
      }
    },
  );

  /**
   * Deliberate restart after a refused save or delete: drop the draft and
   * reseed the form from the gateway (#726). It reloads as the other reload
   * paths do, so a group's membership is re-read before the form remounts,
   * and the next write expects the membership the operator now sees. If
   * either read fails, the draft and the conflict dialog stay, so the
   * operator can try again or keep editing.
   */
  const handleDiscardAndReload = session.bind(async () => {
    if (activeReload.current || deleting.current || saving.current) return;
    const reloaded = await reloadFromGateway();
    if (reloaded === "abandoned") return;
    if (reloaded !== true) {
      reportReloadFailure(reloaded);
      return;
    }
    setConflict(null);
  });

  /** "Keep my draft": close the dialog and abandon a reload still in flight. */
  const handleKeepEditing = () => {
    abandonReload();
    setConflict(null);
  };

  /**
   * Reload after a saved-but-unverified move (#610), or a save or delete
   * refused because the membership changed since the form was seeded (#630);
   * the remounted form reports its new seed as the membership snapshot. Only
   * fresh reads are adopted: the plugin, and for a group its complete proxy
   * membership, which the form seeds once. If either read fails, the draft
   * and the recovery report stay as they are.
   */
  const handleReloadSaved = session.bind(async () => {
    if (activeReload.current || deleting.current || saving.current) return;
    const reloaded = await reloadFromGateway();
    if (reloaded === "abandoned") return;
    if (reloaded !== true) {
      reportReloadFailure(reloaded);
      return;
    }
    setMembershipError(null);
  });

  function reportReloadFailure(failed: "plugin" | "membership" | "changed") {
    toast(
      "error",
      failed === "plugin"
        ? "Could not re-read the plugin; your form was kept. Try again."
        : failed === "membership"
          ? "Could not re-read the plugin's proxies; your form was kept. Try again."
          : "The plugin changed while it was being reloaded; your form was kept. Try again.",
    );
  }

  /** A cache entry's identity and observations, to detect any change since. */
  function markCache(key: QueryKey) {
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
    return query
      ? {
          query,
          dataUpdatedAt: query.state.dataUpdatedAt,
          errorUpdatedAt: query.state.errorUpdatedAt,
          status: query.state.status,
        }
      : null;
  }

  /**
   * Whether the cache entry at `key` learned something since `mark` that a
   * reload must not paper over: it was removed or replaced (a retirement), it
   * recorded an error (a `404`, say), or it took data that is not what the
   * reload is about to publish (`same` decides). Re-reading the same content
   * is not a change.
   */
  function cacheChangedSince(
    mark: ReturnType<typeof markCache>,
    key: QueryKey,
    same: (cached: unknown) => boolean,
  ): boolean {
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
    if (mark === null) {
      if (!query) return false;
      if (query.state.errorUpdatedAt > 0) return true;
      return query.state.dataUpdatedAt > 0 && !same(query.state.data);
    }
    if (query !== mark.query) return true;
    if (query.state.errorUpdatedAt !== mark.errorUpdatedAt) return true;
    if (query.state.status !== mark.status && query.state.status !== "success") return true;
    return query.state.dataUpdatedAt !== mark.dataUpdatedAt && !same(query.state.data);
  }

  function sameRevision(a: unknown, b: unknown): boolean {
    return resourceFingerprint({ value: a }) === resourceFingerprint({ value: b });
  }

  function abandonReload() {
    activeReload.current?.abort.abort();
    activeReload.current = null;
    setReloading(false);
  }

  // An editor that unmounts (a route or namespace change) abandons its reload.
  useEffect(() => () => activeReload.current?.abort.abort(), []);

  /**
   * Reseed the form, its membership and the baseline from fresh reads, or
   * change nothing and name the read that failed. `"abandoned"` means the
   * reload was superseded or dismissed, or this editor is no longer on
   * screen: nothing was applied, and the caller reports nothing.
   *
   * Both reads are the caller's own, outside their Queries, silent, and
   * aborted when the reload is abandoned:
   * every caller reports a failure itself. Their results are published only
   * once everything the form needs has loaded, after cancelling any refetch
   * of the same keys (the save's settle invalidation, say) that could land
   * on top of them. Membership is read whenever the fresh plugin is a group,
   * whatever scope the page showed, since the form seeds it once.
   *
   * `"changed"`: while the reload ran, a cache it writes (the plugin detail,
   * or the proxy list for a group) learned something: a different revision
   * or membership, an error such as a `404`, or the entry was retired. Which
   * observation is newer cannot be told, so nothing is published and the
   * caller asks for another try (`cacheChangedSince`).
   */
  async function reloadFromGateway(): Promise<
    true | "plugin" | "membership" | "changed" | "abandoned"
  > {
    // An editor that is deleting, or no longer on screen (a committed save
    // answered after a route or namespace change), starts no read at all.
    if (deleting.current || !session.isCurrent()) return "abandoned";
    abandonReload();
    const reload = { token: ++reloadCounter.current, abort: new AbortController() };
    activeReload.current = reload;
    setReloading(true);
    // Delete and reload exclude each other: a confirmation opened against
    // this form must not authorize the membership a remount would show.
    setDeleteOpen(false);
    const live = () =>
      activeReload.current?.token === reload.token && session.isCurrent() && !deleting.current;
    const detailKey = pluginConfigKey(scope.namespace, pluginId);
    const membersKey = allProxiesKey(scope.namespace);
    // What each cache this reload writes held when it started.
    const detailMark = markCache(detailKey);
    const membersMark = markCache(membersKey);
    const finish = <T,>(result: T): T => {
      if (activeReload.current?.token === reload.token) {
        activeReload.current = null;
        setReloading(false);
      }
      return result;
    };

    let fresh: PluginConfig;
    try {
      fresh = await pluginsApi.getConfig(scope, pluginId, true, reload.abort.signal);
    } catch {
      return finish(live() ? "plugin" : "abandoned");
    }
    if (!live()) return finish("abandoned");

    let members: Proxy[] | undefined;
    if (fresh.scope === "proxy_group") {
      try {
        members = await proxiesApi.listAll(scope, reload.abort.signal, true);
      } catch {
        return finish(live() ? "membership" : "abandoned");
      }
      if (!live()) return finish("abandoned");
    }

    await Promise.all([
      queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
      members && queryClient.cancelQueries({ queryKey: membersKey, exact: true }),
    ]);
    if (!live()) return finish("abandoned");

    if (
      cacheChangedSince(detailMark, detailKey, (cached) =>
        sameRevision(pluginsApi.toBaseline(cached as PluginConfig), pluginsApi.toBaseline(fresh)),
      ) ||
      (members !== undefined &&
        cacheChangedSince(membersMark, membersKey, (cached) => sameRevision(cached, members)))
    ) {
      return finish("changed");
    }

    setDeleteOpen(false);
    if (members) queryClient.setQueryData<Proxy[]>(membersKey, members);
    queryClient.setQueryData<PluginConfig>(detailKey, fresh);
    baseline.adopt(fresh);
    setFormGeneration((generation) => generation + 1);
    return finish(true);
  }

  const handleDelete = session.bind(async () => {
    const seen = membershipSeen.current;
    // Not while a save (and the reseed a committed save runs) or a reload can
    // still replace the form this confirmation was given against.
    if (
      !plugin || !capability.allowed || !seen ||
      activeReload.current || updatePlugin.isPending || saving.current || deleting.current
    ) return;
    deleting.current = true;
    setMembershipError(null);
    try {
      // Judged against the configuration this page is displaying — see the
      // proxy detail page — and the membership its form shows.
      const deleted = await deletePlugin.mutateAsync({
        id: pluginId,
        guard: pluginsApi.pluginDeleteGuard(plugin),
        observedProxyIds: seen,
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
      // Nothing was deleted: the editor is live again.
      deleting.current = false;
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

  const needsMembership = membershipDisplayed;

  // listAll resolves only after every page succeeds; partial membership must
  // never become the initial selection for a full membership replacement.
  // Gates that withhold the form until its seed is complete. Once a form has
  // mounted (`formSeeded`), membership that is pending or failed is reported
  // beside it instead, so the draft and any conflict dialog stay.
  const membershipMissing = !formSeeded && needsMembership && !allProxies;
  if (isLoading || pluginsLoading || (membershipMissing && proxiesPending)) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!plugin || membershipMissing) {
    if (deletePlugin.isPending || deletePlugin.isSuccess) {
      return null;
    }
    return (
      <div className="max-w-2xl space-y-4">
        <PluginMembershipRecovery error={membershipError} role={facts.role} />
        {/* Denied, unavailable or gone: the shared notice says which, instead
            of a fixed failure line (#680). */}
        {plugin ? (
          <ReadStateNotice query={proxiesQuery} label="Proxy group membership" />
        ) : (
          <ReadStateNotice query={resourceQuery} label="Plugin configuration" />
        )}
        <Button
          variant="secondary"
          onClick={() => navigate({ to: "/plugins" })}
        >
          Back to Plugins
        </Button>
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
            <Button
              variant="danger"
              disabled={reloading || updatePlugin.isPending}
              onClick={() => {
                if (!activeReload.current && !deleting.current && !saving.current) {
                  setDeleteOpen(true);
                }
              }}
            >
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
        <PluginMembershipRecovery error={membershipError} role={facts.role} />
      )}
      {membershipError instanceof PluginSavedUnverifiedError && (
        <Button
          variant="secondary"
          loading={reloading}
          onClick={() => void handleReloadSaved()}
        >
          Reload saved configuration
        </Button>
      )}
      {membershipError instanceof PluginMembershipChangedError && (
        <Button
          variant="secondary"
          loading={reloading}
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
          // A pending save locks the form too: a committed answer reseeds it,
          // which would erase an edit made in the meantime.
          locked={reloading || updatePlugin.isPending}
          capability={capability}
          role={facts.role}
          availablePlugins={availablePlugins ?? []}
          initialProxyGroupIds={initialProxyGroupIds}
          // A mounted form keeps the seed it was given: a refetch that makes
          // the plugin a group must not remount it as "membership loading".
          initialProxyGroupIdsLoaded={formSeeded || !needsMembership || allProxies !== undefined}
          onSeeded={handleSeeded}
        />
      </Card>

      {/* Refused concurrent-edit save or delete */}
      <StaleWriteDialog
        conflict={conflict}
        onKeepEditing={handleKeepEditing}
        onDiscardAndReload={() => void handleDiscardAndReload()}
        reloading={reloading}
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
