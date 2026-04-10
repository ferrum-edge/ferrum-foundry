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
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { UpstreamForm } from "@/components/forms/UpstreamForm";
import { TargetForm } from "@/components/forms/TargetForm";
import type { UpstreamCreate, UpstreamTarget } from "@/api/types";

export default function UpstreamDetailPage() {
  const { upstreamId } = useParams({ strict: false }) as { upstreamId: string };
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: upstream, isLoading, isError } = useUpstream(upstreamId);
  const updateUpstream = useUpdateUpstream();
  const deleteUpstream = useDeleteUpstream();

  const [deleteOpen, setDeleteOpen] = useState(false);

  /* ---------- Targets tab state ---------- */
  const [showTargetForm, setShowTargetForm] = useState(false);
  const [editingTargetIndex, setEditingTargetIndex] = useState<number | null>(null);

  /* ---------- Handlers ---------- */

  const handleSubmit = async (data: UpstreamCreate) => {
    try {
      await updateUpstream.mutateAsync({ id: upstreamId, data });
      toast("success", "Upstream updated successfully");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update upstream";
      toast("error", message);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteUpstream.mutateAsync(upstreamId);
      toast("success", "Upstream deleted successfully");
      navigate({ to: "/upstreams" });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to delete upstream";
      toast("error", message);
    }
  };

  /* ---------- Target management (Targets tab) ---------- */

  const saveTargets = async (newTargets: UpstreamTarget[]) => {
    if (!upstream) return;
    try {
      await updateUpstream.mutateAsync({
        id: upstreamId,
        data: {
          targets: newTargets,
          algorithm: upstream.algorithm,
          ...(upstream.name && { name: upstream.name }),
          ...(upstream.hash_on && { hash_on: upstream.hash_on }),
          ...(upstream.hash_on_cookie_config && { hash_on_cookie_config: upstream.hash_on_cookie_config }),
          ...(upstream.health_checks && { health_checks: upstream.health_checks }),
          ...(upstream.service_discovery && { service_discovery: upstream.service_discovery }),
        },
      });
      toast("success", "Targets updated successfully");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update targets";
      toast("error", message);
    }
  };

  const handleAddTarget = async (target: UpstreamTarget) => {
    if (!upstream) return;
    await saveTargets([...upstream.targets, target]);
    setShowTargetForm(false);
  };

  const handleUpdateTarget = async (target: UpstreamTarget) => {
    if (!upstream || editingTargetIndex === null) return;
    const newTargets = upstream.targets.map((t, i) =>
      i === editingTargetIndex ? target : t,
    );
    await saveTargets(newTargets);
    setEditingTargetIndex(null);
  };

  const handleRemoveTarget = async (index: number) => {
    if (!upstream) return;
    const newTargets = upstream.targets.filter((_, i) => i !== index);
    await saveTargets(newTargets);
    if (editingTargetIndex === index) setEditingTargetIndex(null);
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

  if (isError || !upstream) {
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

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {upstream.name || "Upstream Detail"}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">{upstream.id}</p>
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

      {/* Tabs */}
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="targets">
            Targets ({upstream.targets.length})
          </TabsTrigger>
        </TabsList>

        {/* Config tab */}
        <TabsContent value="config">
          <Card>
            <UpstreamForm
              initialData={upstream}
              onSubmit={handleSubmit}
              isLoading={updateUpstream.isPending}
            />
          </Card>
        </TabsContent>

        {/* Targets tab */}
        <TabsContent value="targets">
          <Card>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">
                  Targets ({upstream.targets.length})
                </h3>
                {!showTargetForm && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditingTargetIndex(null);
                      setShowTargetForm(true);
                    }}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Add Target
                  </Button>
                )}
              </div>

              {/* Target list */}
              {upstream.targets.length > 0 && (
                <div className="space-y-2">
                  {upstream.targets.map((target, index) => (
                    <div key={`${target.host}-${target.port}-${index}`}>
                      {editingTargetIndex === index ? (
                        <TargetForm
                          initialData={target}
                          onSubmit={handleUpdateTarget}
                          onCancel={() => setEditingTargetIndex(null)}
                        />
                      ) : (
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
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setShowTargetForm(false);
                                setEditingTargetIndex(index);
                              }}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveTarget(index)}
                            >
                              <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {upstream.targets.length === 0 && !showTargetForm && (
                <p className="text-text-muted text-sm py-4 text-center">
                  No targets configured. Add a target to start routing traffic.
                </p>
              )}

              {/* Inline add form */}
              {showTargetForm && (
                <TargetForm
                  onSubmit={handleAddTarget}
                  onCancel={() => setShowTargetForm(false)}
                />
              )}
            </div>
          </Card>
        </TabsContent>
      </Tabs>

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
