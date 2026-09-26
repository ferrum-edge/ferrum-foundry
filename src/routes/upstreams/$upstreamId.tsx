import { ResourceLabels } from "@/components/shared/ResourceLabels";
/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream detail / edit page                       */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useUpstream,
  useUpdateUpstream,
  useDeleteUpstream,
} from "@/hooks/useUpstreams";
import { ReadStateNotice } from '@/components/shared/ReadState';
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { UpstreamForm } from "@/components/forms/UpstreamForm";
import { TargetForm } from "@/components/forms/TargetForm";
import { committedWriteMessage, getApiErrorMessage, getCommittedWrite } from "@/api/client";
import * as upstreamsApi from "@/api/upstreams";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import { reseedAfterCommit, useEditBaseline } from "@/hooks/useEditBaseline";
import {
  isStaleResourceError,
  type StaleResourceDetail,
  type WriteGuard,
} from "@/api/conditionalWrite";
import { pickSnapshot, resourceFingerprint } from "@/lib/resourceBaseline";
import { targetActionLabels, targetIdentities } from "@/lib/upstreamTargets";
import { StaleWriteDialog } from "@/components/shared/StaleWriteDialog";
import { useCapabilities } from "@/stores/capabilities";
import { CapabilityNotice, WriteAction } from "@/components/shared/CapabilityGate";
import type { Upstream, UpstreamCreate, UpstreamTarget } from "@/api/types";

/**
 * The target list an open target editor (add or edit) was seeded from, and
 * the guard built from that same list. Captured when the editor opens and
 * never advanced by a background refetch: the draft was edited against this
 * list, so this is what the save must be judged against (#445).
 */
interface TargetEditBasis {
  readonly targets: UpstreamTarget[];
  readonly guard: WriteGuard<Upstream | UpstreamCreate>;
}

function targetEditBasis(upstream: Upstream): TargetEditBasis {
  return { targets: upstream.targets, guard: upstreamsApi.targetsWriteGuard(upstream) };
}

/**
 * The one open target editor, if any. An edit form is bound to its target's
 * identity (`targetIdentities`), not to a row position, so a refetch or a
 * removal that shifts the rows neither moves nor remounts it; `index` is the
 * target's position in the captured `targets` the save is computed from.
 */
type TargetDraft =
  | (TargetEditBasis & { readonly mode: "add" })
  | (TargetEditBasis & { readonly mode: "edit"; readonly index: number; readonly identity: string });

const MISSING_TARGET_DRAFT =
  "This target form lost the target list it was opened from, so nothing was saved. Cancel it and open the target again.";

function sameTargetBaseline(
  a: WriteGuard<Upstream | UpstreamCreate>,
  b: WriteGuard<Upstream | UpstreamCreate>,
): boolean {
  return resourceFingerprint(a.baseline) === resourceFingerprint(b.baseline);
}

function holdsTargets(upstream: Upstream, targets: UpstreamTarget[]): boolean {
  return (
    resourceFingerprint(pickSnapshot(upstream, ["targets"])) ===
    resourceFingerprint(pickSnapshot({ targets }, ["targets"]))
  );
}

/**
 * The route component survives a namespace switch; `UpstreamEditor` is keyed
 * on `{ namespace, upstreamId }` so the form, the inline target editors, and
 * the delete confirmation remount against the newly selected tenant (see
 * `src/lib/editorIdentity.ts`).
 */
export default function UpstreamDetailPage() {
  const { upstreamId } = useParams({ strict: false }) as { upstreamId: string };
  const { toast } = useToast();
  const session = useEditorIdentity(upstreamId, {
    onStale: () => toast("warning", STALE_EDITOR_MESSAGE),
  });

  return <UpstreamEditor key={session.key} session={session} />;
}

function UpstreamEditor({ session }: { session: EditorSession }) {
  const upstreamId = session.identity.resourceId;
  const navigate = useNavigate();
  const { toast } = useToast();

  const { capabilities } = useCapabilities();
  const capability = capabilities.upstreams;
  const updateUpstream = useUpdateUpstream();
  const deleteUpstream = useDeleteUpstream();
  const detailLive = !deleteUpstream.isPending && !deleteUpstream.isSuccess;
  const resourceQuery = useUpstream(upstreamId, detailLive);
  const { data: upstream, isLoading } = resourceQuery;

  const [deleteOpen, setDeleteOpen] = useState(false);
  // `targets` marks a refusal from the Targets tab, whose "discard and reload"
  // drops the target draft rather than the settings draft.
  const [conflict, setConflict] = useState<{
    detail: StaleResourceDetail;
    source: "settings" | "targets";
  } | null>(null);
  // Bumped only by an explicit "discard my draft and reload".
  const [formGeneration, setFormGeneration] = useState(0);

  // Settings are a whole-resource replacement, so the baseline is the resource
  // this editor was seeded with, captured once and advanced only by an
  // accepted response.
  const baseline = useEditBaseline(upstream, upstreamsApi.upstreamWriteGuard);

  /* ---------- Targets tab state ---------- */
  // The open target form and what it was seeded from. A form is shown only
  // while this holds a draft, so dropping the draft closes the form.
  const [targetDraft, setTargetDraft] = useState<TargetDraft | null>(null);

  /* ---------- Handlers ---------- */

  const handleSubmit = session.bind(async (data: UpstreamCreate) => {
    if (!upstream || updateUpstream.isPending || !capability.allowed) return;
    try {
      const updated = await updateUpstream.mutateAsync({
        id: upstreamId,
        data: upstreamsApi.mergeFormUpdatePayload(upstream, data),
        guard: baseline.current(),
      });
      baseline.adopt(updated);
      toast("success", "Upstream updated successfully");
    } catch (err: unknown) {
      if (isStaleResourceError(err)) {
        setConflict({ detail: err.detail, source: "settings" });
        return;
      }
      const committed = getCommittedWrite(err);
      if (committed) {
        // Saved, only not yet live: reseed from the gateway, as on the proxy
        // detail page.
        const reseeded = await reseedAfterCommit(resourceQuery.refetch, baseline, () =>
          setFormGeneration((generation) => generation + 1),
        );
        toast(
          "warning",
          committedWriteMessage("Upstream saved", committed) +
            (reseeded ? "" : " Foundry could not re-read the upstream; reload it before saving again."),
        );
        return;
      }
      const message = await getApiErrorMessage(err, "Failed to update upstream");
      toast("error", message);
    }
  });

  /** Deliberate restart: drop the draft and reseed the form from the gateway. */
  const handleDiscardAndReload = async () => {
    const source = conflict?.source;
    setConflict(null);
    if (source === "targets") {
      // Only the target draft is discarded; an unsaved settings draft stays.
      // The list re-renders from the refetch, and the next target editor is
      // seeded from it.
      closeTargetEditors();
      await resourceQuery.refetch();
      return;
    }
    const refreshed = await resourceQuery.refetch();
    if (refreshed.data) baseline.adopt(refreshed.data);
    setFormGeneration((generation) => generation + 1);
  };

  const handleDelete = session.bind(async () => {
    if (!upstream || !capability.allowed) return;
    try {
      // Judged against the upstream this page is displaying — see the proxy
      // detail page.
      const deleted = await deleteUpstream.mutateAsync({
        id: upstreamId,
        guard: upstreamsApi.upstreamWriteGuard(upstream),
      });
      if (deleted.committed) {
        toast("warning", committedWriteMessage("Upstream deleted", deleted.committed));
      } else {
        toast("success", "Upstream deleted successfully");
      }
      navigate({ to: "/upstreams" });
    } catch (err: unknown) {
      if (isStaleResourceError(err)) {
        setDeleteOpen(false);
        setConflict({ detail: err.detail, source: "settings" });
        return;
      }
      const message = await getApiErrorMessage(err, "Failed to delete upstream");
      toast("error", message);
    }
  });

  /* ---------- Target management (Targets tab) ---------- */

  const closeTargetEditors = () => setTargetDraft(null);

  const openAddTarget = (source: Upstream) => {
    setTargetDraft({ ...targetEditBasis(source), mode: "add" });
  };

  const openEditTarget = (source: Upstream, index: number) => {
    setTargetDraft({
      ...targetEditBasis(source),
      mode: "edit",
      index,
      identity: targetIdentities(source.targets)[index],
    });
  };

  // Every target edit funnels through this one bound write. Its guard is built
  // from the list the new list was computed from — the list the operator
  // actually saw: for the add and edit forms, the list captured when the form
  // opened (a background refetch must not advance it past the draft, #445);
  // for a row removal, the list on screen when it was clicked. Only `targets`
  // is compared, so a settings save from this same client still composes
  // (#235/#254). `onSaved` runs only when the targets were written, with the
  // upstream now holding them when that is known: the gateway's answer, or,
  // for a committed-but-not-live answer, a fresh read that holds exactly the
  // list this save wrote. A refused or rejected save keeps the target draft
  // open, as the configuration form does, so the conflict dialog's "Keep
  // editing" has something to return to.
  const saveTargets = session.bind(
    async (
      newTargets: UpstreamTarget[],
      guard: WriteGuard<Upstream | UpstreamCreate>,
      onSaved: (accepted: Upstream | null) => void,
    ) => {
      if (!upstream || updateUpstream.isPending || !capability.allowed) return;
      let accepted: Upstream;
      try {
        accepted = await updateUpstream.mutateAsync({
          id: upstreamId,
          targets: newTargets,
          guard,
        });
      } catch (err: unknown) {
        if (isStaleResourceError(err)) {
          setConflict({ detail: err.detail, source: "targets" });
          return;
        }
        const committed = getCommittedWrite(err);
        if (committed) {
          // The targets were written; only the live apply lagged. A fresh
          // read stands in for the gateway's answer only when it holds
          // exactly what this save wrote — anything else may include another
          // writer's change, which an open form must not be rebased onto.
          const refreshed = await resourceQuery.refetch();
          const fresh = refreshed.isError ? undefined : refreshed.data;
          toast("warning", committedWriteMessage("Targets saved", committed));
          onSaved(fresh && holdsTargets(fresh, newTargets) ? fresh : null);
          return;
        }
        const message = await getApiErrorMessage(err, "Failed to update targets");
        toast("error", message);
        return;
      }
      toast("success", "Targets updated successfully");
      onSaved(accepted);
    },
  );

  const handleAddTarget = async (target: UpstreamTarget) => {
    if (!upstream || updateUpstream.isPending) return;
    if (targetDraft?.mode !== "add") {
      toast("error", MISSING_TARGET_DRAFT);
      return;
    }
    await saveTargets([...targetDraft.targets, target], targetDraft.guard, closeTargetEditors);
  };

  const handleUpdateTarget = async (target: UpstreamTarget) => {
    if (!upstream || updateUpstream.isPending) return;
    if (targetDraft?.mode !== "edit") {
      toast("error", MISSING_TARGET_DRAFT);
      return;
    }
    const edited = targetDraft.index;
    const newTargets = targetDraft.targets.map((t, i) => (i === edited ? target : t));
    await saveTargets(newTargets, targetDraft.guard, closeTargetEditors);
  };

  const handleRemoveTarget = async (index: number) => {
    if (!upstream || updateUpstream.isPending) return;
    const removed = targetIdentities(upstream.targets)[index];
    const newTargets = upstream.targets.filter((_, i) => i !== index);
    const guard = upstreamsApi.targetsWriteGuard(upstream);
    await saveTargets(newTargets, guard, (result) => {
      setTargetDraft((draft) => {
        if (!draft) return draft;
        // Removing the target being edited drops its draft, which closes the
        // form.
        if (draft.mode === "edit" && draft.identity === removed) return null;
        // This page's own removal moves an open editor's basis only when that
        // editor was seeded from the very list the removal was computed from
        // and the upstream now holding the result is known. Otherwise the
        // basis stays, and a save from it is refused rather than rebased onto
        // content the operator never edited against.
        if (!result || !sameTargetBaseline(draft.guard, guard)) return draft;
        if (draft.mode === "add") return { ...targetEditBasis(result), mode: "add" };
        // The bases match, so the draft's index and the removed row's index
        // are positions in the same list.
        const moved = draft.index > index ? draft.index - 1 : draft.index;
        return {
          ...targetEditBasis(result),
          mode: "edit",
          index: moved,
          identity: targetIdentities(result.targets)[moved] ?? draft.identity,
        };
      });
    });
  };

  /* ---------- Loading / Error states ---------- */

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!upstream) {
    if (deleteUpstream.isPending || deleteUpstream.isSuccess) {
      return null;
    }
    return (
      <div className="max-w-2xl">
        <Card>
          <p className="text-text-secondary">
            Failed to load upstream configuration.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => navigate({ to: "/upstreams" })}
          >
            Back to Upstreams
          </Button>
        </Card>
      </div>
    );
  }

  /* ---------- Render ---------- */

  // The rows on screen, each with its identity. An open edit form whose
  // target a refetch no longer lists keeps its place (at its captured
  // position) instead of vanishing with the operator's typing.
  const editingDraft = targetDraft?.mode === "edit" ? targetDraft : null;
  const identities = targetIdentities(upstream.targets);
  const targetRows: { target: UpstreamTarget; index: number | null; identity: string }[] =
    upstream.targets.map((target, index) => ({ target, index, identity: identities[index] }));
  if (editingDraft && !identities.includes(editingDraft.identity)) {
    targetRows.splice(Math.min(editingDraft.index, targetRows.length), 0, {
      target: editingDraft.targets[editingDraft.index],
      index: null,
      identity: editingDraft.identity,
    });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {resourceQuery.isError && (
        <ReadStateNotice query={resourceQuery} label="Upstream configuration" />
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {upstream.name || "Upstream Detail"}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">{upstream.id}</p>
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

      <ResourceLabels labels={upstream.labels} />

      {/* Tabs */}
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="targets">
            Targets ({upstream.targets.length})
          </TabsTrigger>
        </TabsList>

        {/* Config tab */}
        <TabsContent value="config" keepMounted>
          <Card>
            <UpstreamForm
              key={formGeneration}
              initialData={upstream}
              onSubmit={handleSubmit}
              isLoading={updateUpstream.isPending}
              capability={capability}
            />
          </Card>
        </TabsContent>

        {/* Targets tab */}
        <TabsContent value="targets">
          <CapabilityNotice verdict={capability} className="mb-4" />
          <fieldset disabled={updateUpstream.isPending || !capability.allowed} className="min-w-0">
          <Card>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">
                  Targets ({upstream.targets.length})
                </h3>
                {targetDraft?.mode !== "add" && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => openAddTarget(upstream)}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Add Target
                  </Button>
                )}
              </div>

              {/* Target list */}
              {targetRows.length > 0 && (
                <div className="space-y-2">
                  {targetRows.map(({ target, index, identity }) => (
                    // Keyed by the target's identity, not its position, so a
                    // refetch or a removal that shifts the rows does not
                    // remount an open editor or move it to another target.
                    <div key={identity}>
                      {editingDraft?.identity === identity ? (
                        <>
                          <TargetForm
                            initialData={editingDraft.targets[editingDraft.index]}
                            onSubmit={handleUpdateTarget}
                            onCancel={closeTargetEditors}
                          />
                          {index === null && (
                            <p role="status" className="text-warning text-xs mt-2">
                              This target is no longer in the upstream&apos;s current list.
                              Update Target shows what changed instead of saving; Cancel
                              discards the draft.
                            </p>
                          )}
                        </>
                      ) : (
                        index !== null && (
                          <TargetRow
                            target={target}
                            labels={targetActionLabels(upstream.targets, index)}
                            onEdit={() => openEditTarget(upstream, index)}
                            onRemove={() => handleRemoveTarget(index)}
                          />
                        )
                      )}
                    </div>
                  ))}
                </div>
              )}

              {targetRows.length === 0 && targetDraft?.mode !== "add" && (
                <p className="text-text-muted text-sm py-4 text-center">
                  No targets configured. Add a target to start routing traffic.
                </p>
              )}

              {/* Inline add form */}
              {targetDraft?.mode === "add" && (
                <TargetForm
                  onSubmit={handleAddTarget}
                  onCancel={closeTargetEditors}
                />
              )}
            </div>
          </Card>
          </fieldset>
        </TabsContent>
      </Tabs>

      {/* Refused concurrent-edit save */}
      <StaleWriteDialog
        conflict={conflict?.detail ?? null}
        onKeepEditing={() => setConflict(null)}
        onDiscardAndReload={handleDiscardAndReload}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Upstream"
        description={`Are you sure you want to delete "${upstream.name || upstream.id}"? This action cannot be undone.`}
        confirmLabel="Delete Upstream"
        variant="danger"
        onConfirm={handleDelete}
        loading={deleteUpstream.isPending}
      />
    </div>
  );
}

/** One target's read-only row, with its edit and remove actions. */
function TargetRow({
  target,
  labels,
  onEdit,
  onRemove,
}: {
  target: UpstreamTarget;
  labels: { edit: string; remove: string };
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-bg-primary/50 border border-border rounded-lg p-3 flex items-center justify-between">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-text-primary font-mono">
          {target.host}:{target.port}
        </span>
        <Badge variant="default">weight {target.weight}</Badge>
        {target.path && (
          <Badge variant="blue">{target.path}</Badge>
        )}
        {target.tags && Object.keys(target.tags).length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {Object.entries(target.tags).map(([k, v]) => (
              <Badge key={k} variant="purple">
                {k}:{v}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button type="button" variant="ghost" size="sm" aria-label={labels.edit} onClick={onEdit}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-label={labels.remove} onClick={onRemove}>
          <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </Button>
      </div>
    </div>
  );
}
