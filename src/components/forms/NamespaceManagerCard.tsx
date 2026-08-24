/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Namespace management card (create/rename/delete) */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { useNamespace } from "@/stores/namespace";
import {
  useNamespaces,
  useNamespaceDetail,
  useCreateNamespace,
  useUpdateNamespace,
  useDeleteNamespace,
} from "@/hooks/useNamespaces";
import {
  buildNamespaceUpdate,
  validateNamespaceName,
  NAMESPACE_DESCRIPTION_MAX_LENGTH,
} from "@/api/namespaces";
import { getApiErrorMessage } from "@/api/client";

const DEFAULT_NAMESPACE = "ferrum";

/* ================================================================== */
/*  Create dialog                                                     */
/* ================================================================== */

function CreateNamespaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const createNamespace = useCreateNamespace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setNameError(null);
    }
  }, [open]);

  async function handleSubmit() {
    const error = validateNamespaceName(name.trim());
    setNameError(error);
    if (error) return;

    try {
      await createNamespace.mutateAsync({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast("success", `Namespace "${name.trim()}" created`);
      onOpenChange(false);
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Failed to create namespace"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create Namespace</DialogTitle>
        <DialogDescription className="mt-2">
          Registers an empty tenant so resources can be created under it.
        </DialogDescription>
        <div className="space-y-4 mt-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(validateNamespaceName(e.target.value.trim()));
            }}
            error={nameError ?? undefined}
            helpText="Letters, digits, dots, hyphens, underscores; must start with a letter or digit"
            placeholder="e.g. staging"
            autoFocus
          />
          <Input
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={NAMESPACE_DESCRIPTION_MAX_LENGTH}
            placeholder="What this tenant is for"
          />
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={createNamespace.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={createNamespace.isPending}>
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/*  Edit (rename / description) dialog                                */
/* ================================================================== */

function EditNamespaceDialog({
  target,
  onOpenChange,
}: {
  target: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const { selectedNamespace, setNamespace } = useNamespace();
  const updateNamespace = useUpdateNamespace();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [originalDescription, setOriginalDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  // Stop observing the detail once a save is submitted. On a rename the old
  // key stops resolving the moment the gateway commits, and a still-active
  // observer would refetch it into a spurious 404 popup.
  const [submitted, setSubmitted] = useState(false);

  const detail = useNamespaceDetail(target && !submitted ? target : "");

  // Seed the form once per target: on open with the name, then again when
  // that target's detail first arrives. Keyed on the description value (not
  // the query object) so a later refetch cannot clobber in-progress edits.
  const seededFor = useRef<string | null>(null);
  const loadedDescription = detail.data?.description ?? null;

  useEffect(() => {
    if (!target) {
      seededFor.current = null;
      setSubmitted(false);
      return;
    }
    if (seededFor.current === target) return;

    setName(target);
    setNameError(null);
    // Wait for the detail before seeding the description, so the field is
    // not briefly empty and then overwritten under the user's cursor.
    if (detail.isSuccess) {
      setDescription(loadedDescription ?? "");
      setOriginalDescription(loadedDescription ?? "");
      seededFor.current = target;
    } else {
      setDescription("");
      setOriginalDescription("");
    }
  }, [target, detail.isSuccess, loadedDescription]);

  async function handleSubmit() {
    if (!target) return;

    const error = validateNamespaceName(name.trim());
    setNameError(error);
    if (error) return;

    const payload = buildNamespaceUpdate(
      { name: target, description: originalDescription },
      { name, description },
    );
    if (!payload) {
      onOpenChange(false);
      return;
    }

    setSubmitted(true);
    try {
      const updated = await updateNamespace.mutateAsync({
        name: target,
        data: payload,
      });
      // Follow a rename of the namespace the UI is currently scoped to.
      if (payload.name && target === selectedNamespace) {
        setNamespace(updated.name);
      }
      toast("success", `Namespace "${updated.name}" updated`);
      onOpenChange(false);
    } catch (err) {
      // Nothing was renamed, so the detail key still resolves — resume
      // observing it so a retry compares against fresh server state.
      setSubmitted(false);
      toast("error", await getApiErrorMessage(err, "Failed to update namespace"));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Edit Namespace</DialogTitle>
        <DialogDescription className="mt-2">
          Renaming moves every resource in the namespace to the new name.
        </DialogDescription>
        <div className="space-y-4 mt-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(validateNamespaceName(e.target.value.trim()));
            }}
            error={nameError ?? undefined}
          />
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={NAMESPACE_DESCRIPTION_MAX_LENGTH}
            helpText="Leave empty to clear the description"
          />
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={updateNamespace.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={updateNamespace.isPending}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/*  Delete dialog (with cascade confirm)                              */
/* ================================================================== */

function DeleteNamespaceDialog({
  target,
  onOpenChange,
}: {
  target: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const { selectedNamespace, setNamespace } = useNamespace();
  const deleteNamespace = useDeleteNamespace();
  const [cascade, setCascade] = useState(false);

  useEffect(() => {
    if (target) setCascade(false);
  }, [target]);

  async function handleDelete() {
    if (!target) return;
    try {
      await deleteNamespace.mutateAsync({ name: target, confirm: cascade });
      // The deleted namespace can no longer be the active scope.
      if (target === selectedNamespace) {
        setNamespace(DEFAULT_NAMESPACE);
      }
      toast("success", `Namespace "${target}" deleted`);
      onOpenChange(false);
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Failed to delete namespace"));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Delete Namespace</DialogTitle>
        <DialogDescription className="mt-2">
          {`Delete namespace "${target ?? ""}"? A namespace that still contains resources is only deleted when cascade is enabled.`}
        </DialogDescription>
        <label className="flex items-start gap-2 mt-4 cursor-pointer">
          <input
            type="checkbox"
            checked={cascade}
            onChange={(e) => setCascade(e.target.checked)}
            className="mt-0.5 accent-orange"
          />
          <span className="text-sm text-text-secondary">
            Cascade-delete all resources (proxies, consumers, plugin configs,
            upstreams, API specs, trust bundle) in this namespace
          </span>
        </label>
        <div className="flex justify-end gap-3 mt-6">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={deleteNamespace.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleDelete}
            loading={deleteNamespace.isPending}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/*  NamespaceManagerCard                                              */
/* ================================================================== */

export function NamespaceManagerCard() {
  const { selectedNamespace } = useNamespace();
  const { data: namespaces, isLoading } = useNamespaces();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Manage Namespaces
        </h3>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          New Namespace
        </Button>
      </div>

      {isLoading ? (
        <div className="h-24 bg-bg-card-hover rounded animate-pulse" />
      ) : !namespaces || namespaces.length === 0 ? (
        <p className="text-sm text-text-muted">
          No namespaces returned from the gateway.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {namespaces.map((ns) => (
            <li key={ns} className="flex items-center justify-between py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-text-primary">{ns}</span>
                {ns === selectedNamespace && (
                  <Badge variant="orange">active</Badge>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditTarget(ns)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger"
                  onClick={() => setDeleteTarget(ns)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-text-muted text-xs mt-3">
        The gateway&apos;s own configured namespaces (e.g.{" "}
        <code className="text-text-secondary">ferrum</code>) cannot be renamed
        or deleted.
      </p>

      <CreateNamespaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditNamespaceDialog
        target={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      />
      <DeleteNamespaceDialog
        target={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      />
    </Card>
  );
}
