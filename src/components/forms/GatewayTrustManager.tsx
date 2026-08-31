import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/Input";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  getGatewayTrustRevisionConflict,
  type GatewayTrustBundle,
  type GatewayTrustRevisionConflict,
} from "@/api/trust";
import {
  useCreateTrustBundle,
  useDeleteTrustBundle,
  useTrustBundles,
  useTrustStatus,
  useUpdateTrustBundle,
} from "@/hooks/useTrust";
import {
  buildTrustBundlePayload,
  EMPTY_TRUST_BUNDLE_FORM,
  trustBundleToForm,
  TrustBundleFormError,
  type TrustBundleFormState,
} from "@/lib/trustBundleForm";
import { useNamespace } from "@/stores/namespace";

interface EditorState {
  mode: "create" | "edit";
  namespace: string;
  target: GatewayTrustBundle | null;
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 5,
  helpText,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  helpText?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-text-secondary text-sm font-medium">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
        spellCheck={false}
        autoComplete="off"
      />
      {helpText && <span className="text-xs text-text-muted">{helpText}</span>}
    </label>
  );
}

function countAuthorities(bundle: GatewayTrustBundle): {
  x509: number;
  jwt: number;
  federated: number;
} {
  return {
    x509: bundle.bundle.local.x509_authorities?.length ?? 0,
    jwt: bundle.bundle.local.jwt_authorities?.length ?? 0,
    federated: bundle.bundle.federated?.length ?? 0,
  };
}

export function GatewayTrustManager() {
  const { toast } = useToast();
  const { selectedNamespace } = useNamespace();
  const bundlesQuery = useTrustBundles();
  const statusQuery = useTrustStatus();
  const createBundle = useCreateTrustBundle();
  const updateBundle = useUpdateTrustBundle();
  const deleteBundle = useDeleteTrustBundle();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<TrustBundleFormState>(EMPTY_TRUST_BUNDLE_FORM);
  const [conflict, setConflict] = useState<GatewayTrustRevisionConflict | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    bundle: GatewayTrustBundle;
    namespace: string;
  } | null>(null);

  const clearEditor = () => {
    setEditor(null);
    setConflict(null);
    setForm(EMPTY_TRUST_BUNDLE_FORM);
  };

  useEffect(() => {
    // Namespace changes retire all pinned mutation state and public-key form
    // buffers. A form opened for one tenant can never submit into another.
    setEditor(null);
    setConflict(null);
    setDeleteTarget(null);
    setForm(EMPTY_TRUST_BUNDLE_FORM);
  }, [selectedNamespace]);

  const bundle = bundlesQuery.data?.data?.[0];
  const status = statusQuery.data;

  if (bundlesQuery.isLoading && statusQuery.isLoading) return <SkeletonCard />;
  if (bundlesQuery.isError && statusQuery.isError && !status) {
    return (
      <EmptyState
        title="Gateway trust unavailable"
        description="This endpoint is unavailable outside supported mesh/database modes."
      />
    );
  }

  const openCreate = () => {
    setForm(EMPTY_TRUST_BUNDLE_FORM);
    setEditor({ mode: "create", namespace: selectedNamespace, target: null });
  };

  const openEdit = (target: GatewayTrustBundle) => {
    setForm(trustBundleToForm(target));
    setEditor({ mode: "edit", namespace: selectedNamespace, target });
  };

  const save = async () => {
    if (!editor) return;
    try {
      if (
        editor.mode === "edit" &&
        (!editor.target ||
          !Number.isSafeInteger(editor.target.revision) ||
          editor.target.revision < 1)
      ) {
        throw new TrustBundleFormError(
          "The loaded trust bundle has no usable revision; reload it before editing",
        );
      }
      const payload = buildTrustBundlePayload(
        form,
        editor.target?.revision,
      );
      if (editor.mode === "create") {
        await createBundle.mutateAsync({ data: payload, namespace: editor.namespace });
      } else if (editor.target) {
        await updateBundle.mutateAsync({
          id: editor.target.id,
          data: payload,
          namespace: editor.namespace,
        });
      }
      toast(
        "success",
        `Trust bundle ${editor.mode === "create" ? "created" : "rotated"}; publication status is refreshing.`,
      );
      clearEditor();
    } catch (error) {
      if (error instanceof TrustBundleFormError) {
        toast("error", error.message);
        return;
      }
      const revisionConflict = getGatewayTrustRevisionConflict(error);
      if (revisionConflict) {
        setConflict(revisionConflict);
        return;
      }
      toast("error", await getApiErrorMessage(error, "Trust bundle save failed"));
    }
  };

  const counts = bundle ? countAuthorities(bundle) : null;

  return (
    <div className="space-y-4">
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wider">Configured</p>
            <p className={`text-xl font-bold mt-1 ${status.configured ? "text-success" : "text-warning"}`}>
              {status.configured ? "yes" : "no"}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wider">Authority</p>
            <p className={`text-xl font-bold mt-1 ${status.authority_unresolved ? "text-danger" : "text-success"}`}>
              {status.authority_unresolved ? "unresolved" : "resolved"}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wider">Published</p>
            <p className="text-xl font-bold mt-1 text-text-primary">
              {status.process.published_generations_total}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-text-muted uppercase tracking-wider">Load rejections</p>
            <p className={`text-xl font-bold mt-1 ${status.process.load_rejections_total > 0 ? "text-warning" : "text-success"}`}>
              {status.process.load_rejections_total}
            </p>
          </Card>
        </div>
      )}

      {status && (
        <Card className={status.process.last_failure_reason === "none" ? "" : "border-warning/40"}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">Publication status</span>
            <Badge variant={status.authority_unresolved ? "red" : "green"}>
              {status.authority_unresolved ? "unresolved" : "published"}
            </Badge>
            <span className="text-xs text-text-muted font-mono break-all">
              generation {status.generation || "not published"}
            </span>
          </div>
          {status.process.last_failure_reason !== "none" && (
            <p className="text-xs text-warning mt-2">
              Last rejection: {status.process.last_failure_reason.replace(/_/g, " ")}
            </p>
          )}
        </Card>
      )}

      {bundle && counts ? (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-text-primary font-mono">
                  {bundle.trust_domain}
                </h3>
                <Badge variant="blue">revision {bundle.revision}</Badge>
              </div>
              <p className="text-xs text-text-muted mt-2">
                {counts.x509} X.509 · {counts.jwt} JWT · {counts.federated} federated
                {bundle.updated_at ? ` · updated ${new Date(bundle.updated_at).toLocaleString()}` : ""}
              </p>
              <p className="text-xs text-text-muted mt-1">
                namespace <span className="font-mono">{bundle.namespace}</span> · id {" "}
                <span className="font-mono">{bundle.id}</span>
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="secondary" size="sm" onClick={() => openEdit(bundle)}>
                Edit / Rotate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget({ bundle, namespace: selectedNamespace })}
              >
                <span className="text-danger">Delete</span>
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No gateway trust bundle"
          description={`Namespace ${selectedNamespace} has no SPIFFE trust bundle configured.`}
          action={<Button size="sm" onClick={openCreate}>Create Trust Bundle</Button>}
        />
      )}

      <Dialog
        open={!!editor && !conflict}
        onOpenChange={(open) => !open && clearEditor()}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogTitle>
            {editor?.mode === "edit" ? "Edit / rotate trust bundle" : "Create trust bundle"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            Target namespace: <span className="font-mono">{editor?.namespace}</span>.
            Public trust material remains only in this in-memory form and is cleared on close.
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <Input
                label="Resource ID"
                value={form.id}
                disabled={editor?.mode === "edit"}
                onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))}
                placeholder="Defaults to namespace"
                autoComplete="off"
              />
              <Input
                label="Trust domain"
                value={form.trustDomain}
                onChange={(event) => setForm((current) => ({ ...current, trustDomain: event.target.value }))}
                placeholder="example.org"
                autoComplete="off"
              />
            </div>
            <Input
              label="Refresh hint (seconds)"
              type="number"
              min={0}
              step={1}
              value={form.refreshHintSeconds}
              onChange={(event) => setForm((current) => ({ ...current, refreshHintSeconds: event.target.value }))}
            />
            <TextAreaField
              label="Local X.509 authorities (base64 DER)"
              value={form.x509Authorities}
              onChange={(value) => setForm((current) => ({ ...current, x509Authorities: value }))}
              helpText="One complete base64-encoded DER certificate per line; maximum 16. PEM wrappers are not accepted by the gateway contract."
            />
            <TextAreaField
              label="Local JWT authorities (JSON array)"
              value={form.jwtAuthorities}
              onChange={(value) => setForm((current) => ({ ...current, jwtAuthorities: value }))}
              rows={8}
              helpText='Objects require "key_id" and "public_key_pem" (SPKI PUBLIC KEY PEM or a public JWK JSON string). Private keys are rejected.'
            />
            <TextAreaField
              label="Federated bundles (JSON array)"
              value={form.federatedBundles}
              onChange={(value) => setForm((current) => ({ ...current, federatedBundles: value }))}
              rows={8}
              helpText="Each item uses the TrustBundle shape and must have a unique trust_domain plus at least one authority."
            />
            {editor?.target && (
              <p className="text-xs text-text-muted">
                Update will require the exact revision you loaded: {editor.target.revision}.
                Foundry never falls back to an unchecked overwrite.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={clearEditor}>Cancel</Button>
              <Button
                onClick={() => void save()}
                loading={createBundle.isPending || updateBundle.isPending}
              >
                {editor?.mode === "edit" ? "Save rotation" : "Create bundle"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent>
          <DialogTitle>Trust bundle changed concurrently</DialogTitle>
          <DialogDescription className="mt-2">
            Your edit expected revision {conflict?.expected_revision}, but the gateway now
            has revision {conflict?.current_revision}. Nothing was overwritten. Reload the
            current bundle before deciding how to reapply your edits.
          </DialogDescription>
          <div className="flex justify-end gap-2 mt-6">
            <Button variant="secondary" onClick={() => setConflict(null)}>
              Keep unsaved edits
            </Button>
            <Button
              onClick={async () => {
                await Promise.all([bundlesQuery.refetch(), statusQuery.refetch()]);
                clearEditor();
                toast("info", "Current trust bundle reloaded; no stale edit was submitted.");
              }}
            >
              Reload current bundle
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete trust for ${deleteTarget?.bundle.trust_domain ?? "this domain"}?`}
        description={`This explicitly revokes namespace "${deleteTarget?.namespace ?? selectedNamespace}" trust roots and tells subscribed data planes to withdraw them. Mesh authentication may fail immediately.`}
        confirmLabel="Revoke Trust Bundle"
        loading={deleteBundle.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteBundle.mutateAsync({
              id: deleteTarget.bundle.id,
              namespace: deleteTarget.namespace,
            });
            toast("success", "Trust bundle revoked; publication status is refreshing.");
            setDeleteTarget(null);
          } catch (error) {
            toast("error", await getApiErrorMessage(error, "Trust bundle delete failed"));
          }
        }}
      />
    </div>
  );
}
