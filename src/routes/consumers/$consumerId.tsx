/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer detail / edit page                       */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useConsumer,
  useUpdateConsumer,
  useDeleteConsumer,
} from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { ConsumerForm } from "@/components/forms/ConsumerForm";
import {
  CredentialForm,
  CREDENTIAL_TYPES,
} from "@/components/forms/CredentialForm";
import { getApiErrorMessage } from "@/api/client";
import type { ConsumerCreate, Consumer } from "@/api/types";

/* ================================================================== */
/*  ConsumerDetailPage                                                 */
/* ================================================================== */

export default function ConsumerDetailPage() {
  const { consumerId } = useParams({ strict: false }) as {
    consumerId: string;
  };
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: consumer, isLoading, isError } = useConsumer(consumerId);
  const updateConsumer = useUpdateConsumer();
  const deleteConsumer = useDeleteConsumer();

  const [deleteOpen, setDeleteOpen] = useState(false);

  /* ---------- Handlers ---------- */

  const handleSubmit = async (data: ConsumerCreate) => {
    try {
      await updateConsumer.mutateAsync({
        id: consumerId,
        data: { ...data, credentials: consumer?.credentials ?? {} },
      });
      toast("success", "Consumer updated successfully");
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to update consumer");
      toast("error", message);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteConsumer.mutateAsync(consumerId);
      toast("success", "Consumer deleted successfully");
      navigate({ to: "/consumers" });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to delete consumer");
      toast("error", message);
    }
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

  if (isError || !consumer) {
    return (
      <div className="max-w-2xl">
        <Card>
          <p className="text-text-secondary">
            Failed to load consumer configuration.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => navigate({ to: "/consumers" })}
          >
            Back to Consumers
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
            {consumer.username}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">
            {consumer.id}
          </p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
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
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="acl">ACL Groups</TabsTrigger>
        </TabsList>

        {/* ── Details Tab ── */}
        <TabsContent value="details">
          <Card>
            <ConsumerForm
              initialData={consumer}
              onSubmit={handleSubmit}
              isLoading={updateConsumer.isPending}
            />
          </Card>
        </TabsContent>

        {/* ── Credentials Tab ── */}
        <TabsContent value="credentials">
          <div className="space-y-6">
            {CREDENTIAL_TYPES.map((credType) => (
              <Card key={credType}>
                <CredentialForm
                  consumerId={consumerId}
                  credentialType={credType}
                  existingCredentials={consumer.credentials?.[credType]}
                />
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── ACL Groups Tab ── */}
        <TabsContent value="acl">
          <Card>
            <AclGroupsManager
              consumerId={consumerId}
              groups={consumer.acl_groups}
              consumer={consumer}
            />
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Consumer"
        description={`Are you sure you want to delete "${consumer.username}"? This will remove all associated credentials and cannot be undone.`}
        confirmLabel="Delete Consumer"
        variant="danger"
        onConfirm={handleDelete}
        loading={deleteConsumer.isPending}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ACL Groups Manager                                                 */
/* ------------------------------------------------------------------ */

function AclGroupsManager({
  consumerId,
  groups,
  consumer,
}: {
  consumerId: string;
  groups: string[];
  consumer: Pick<Consumer, "username" | "custom_id" | "credentials">;
}) {
  const { toast } = useToast();
  const updateConsumer = useUpdateConsumer();
  const [newGroup, setNewGroup] = useState("");

  const handleAddGroup = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newGroup.trim();
    if (!trimmed) return;
    if (groups.includes(trimmed)) {
      toast("warning", "Group already exists");
      return;
    }

    try {
      await updateConsumer.mutateAsync({
        id: consumerId,
        data: {
          username: consumer.username,
          ...(consumer.custom_id && { custom_id: consumer.custom_id }),
          credentials: consumer.credentials ?? {},
          acl_groups: [...groups, trimmed],
        },
      });
      toast("success", `Added group "${trimmed}"`);
      setNewGroup("");
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to add group");
      toast("error", message);
    }
  };

  const handleRemoveGroup = async (group: string) => {
    try {
      await updateConsumer.mutateAsync({
        id: consumerId,
        data: {
          username: consumer.username,
          ...(consumer.custom_id && { custom_id: consumer.custom_id }),
          credentials: consumer.credentials ?? {},
          acl_groups: groups.filter((g) => g !== group),
        },
      });
      toast("success", `Removed group "${group}"`);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to remove group");
      toast("error", message);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddGroup(e as unknown as FormEvent);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">ACL Groups</h3>

      {/* Add group form */}
      <form onSubmit={handleAddGroup} className="flex items-end gap-3">
        <div className="flex-1">
          <label className="text-text-secondary text-sm font-medium block mb-1.5">
            Add Group
          </label>
          <input
            type="text"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter group name"
            className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-text-primary text-sm placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 transition-colors duration-150"
          />
        </div>
        <Button
          type="submit"
          size="md"
          loading={updateConsumer.isPending}
          disabled={!newGroup.trim()}
        >
          Add
        </Button>
      </form>

      {/* Group list */}
      {groups.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {groups.map((group) => (
            <Badge key={group} variant="blue">
              <span className="flex items-center gap-1.5">
                {group}
                <button
                  type="button"
                  onClick={() => handleRemoveGroup(group)}
                  className="text-text-muted hover:text-danger cursor-pointer transition-colors"
                  disabled={updateConsumer.isPending}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </span>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-text-muted text-sm py-2">
          No ACL groups assigned. Add a group above to control access.
        </p>
      )}
    </div>
  );
}
