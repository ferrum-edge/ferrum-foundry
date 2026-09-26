/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Credential management per type                   */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CredentialCopyOnce, submittedSecrets, type SubmittedSecret } from "./CredentialCopyOnce";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { committedWriteMessage, getApiErrorMessage, isUnobservedWrite } from "@/api/client";
import {
  useAppendCredential,
  useDeleteCredentialByIndex,
  useDeleteCredentials,
  useUpdateCredentials,
} from "@/hooks/useConsumers";
import { buildCredentialInput, CredentialInputError } from "@/lib/credentials";
import type { EditorSession } from "@/hooks/useEditorIdentity";
import type { BuiltInCredentialType } from "@/api/types";
import type { CapabilityVerdict } from "@/lib/capabilities";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CredentialFormProps {
  /**
   * The consumer this card edits. The parent keys the whole editor on the
   * session identity, so a half-typed credential and a pending delete are
   * discarded when the namespace or consumer changes.
   */
  session: EditorSession;
  credentialType: BuiltInCredentialType;
  existingCredentials?: unknown;
  revision: number;
  isRefreshing: boolean;
  /**
   * Write capability for consumer credentials. The parent already presents the
   * tab read-only; this is the handler-side short-circuit, so a programmatic
   * submit cannot reach the gateway either.
   */
  capability?: CapabilityVerdict;
}

interface CredentialFieldConfig {
  label: string;
  fields: {
    name: string;
    label: string;
    placeholder: string;
    required: boolean;
    helpText?: string;
    type?: string;
  }[];
}

/* ------------------------------------------------------------------ */
/*  Credential type field definitions                                  */
/* ------------------------------------------------------------------ */

const CREDENTIAL_CONFIGS: Record<string, CredentialFieldConfig> = {
  keyauth: {
    label: "Key Authentication",
    fields: [
      {
        name: "key",
        label: "API Key",
        placeholder: "Enter a unique API key",
        required: true,
        helpText: "Required. This gateway endpoint does not auto-generate keys.",
      },
    ],
  },
  basicauth: {
    label: "Basic Authentication",
    fields: [
      {
        name: "password",
        label: "Password",
        placeholder: "password",
        required: true,
        type: "password",
      },
    ],
  },
  jwt: {
    label: "JWT",
    fields: [
      {
        name: "secret",
        label: "Secret",
        placeholder: "JWT signing secret",
        required: true,
        helpText: "The secret used to sign and verify JWT tokens.",
      },
    ],
  },
  hmac_auth: {
    label: "HMAC Authentication",
    fields: [
      {
        name: "secret",
        label: "Secret",
        placeholder: "HMAC secret key",
        required: true,
        helpText: "The shared secret for HMAC signature generation and verification.",
      },
    ],
  },
  mtls_auth: {
    label: "Mutual TLS Authentication",
    fields: [
      {
        name: "identity",
        label: "Identity",
        placeholder: "Certificate CN or SAN",
        required: true,
        helpText:
          "The identity to match against the client certificate (usually CN or SAN).",
      },
    ],
  },
};

/* ------------------------------------------------------------------ */
/*  Badge variant for each credential type                             */
/* ------------------------------------------------------------------ */

const CRED_BADGE_VARIANT: Record<string, "orange" | "blue" | "green" | "purple" | "yellow"> = {
  keyauth: "orange",
  basicauth: "blue",
  jwt: "green",
  hmac_auth: "purple",
  mtls_auth: "yellow",
};

/* ------------------------------------------------------------------ */
/*  Helper: render a single existing credential entry                  */
/* ------------------------------------------------------------------ */

function renderCredentialSummary(
  credType: string,
  cred: Record<string, unknown>,
): string {
  switch (credType) {
    case "keyauth":
      return cred.key ? `Key: ${maskString(String(cred.key))}` : "Key (auto-generated)";
    case "jwt":
      return cred.secret ? `Secret: ${maskString(String(cred.secret))}` : "JWT credential";
    case "hmac_auth":
      return cred.secret ? `Secret: ${maskString(String(cred.secret))}` : "HMAC credential";
    case "mtls_auth":
      return cred.identity ? `Identity: ${String(cred.identity)}` : "mTLS credential";
    default:
      return JSON.stringify(cred);
  }
}

function maskString(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

/* ------------------------------------------------------------------ */
/*  Helper: normalize existing credentials into an array               */
/* ------------------------------------------------------------------ */

function normalizeCredentials(
  existing: unknown,
): Record<string, unknown>[] {
  if (!existing) return [];
  if (Array.isArray(existing)) return existing as Record<string, unknown>[];
  if (typeof existing === "object" && existing !== null) {
    return [existing as Record<string, unknown>];
  }
  return [];
}

/* ================================================================== */
/*  CredentialForm                                                     */
/* ================================================================== */

export function CredentialForm({
  session,
  credentialType,
  existingCredentials,
  revision,
  isRefreshing,
  capability,
}: CredentialFormProps) {
  const readOnly = capability !== undefined && !capability.allowed;
  const consumerId = session.identity.resourceId;
  const config = CREDENTIAL_CONFIGS[credentialType];
  const { toast } = useToast();
  const appendCredential = useAppendCredential();
  const deleteCredentialByIndex = useDeleteCredentialByIndex();
  const updateCredentials = useUpdateCredentials();
  const deleteCredentials = useDeleteCredentials();
  const isBasic = credentialType === "basicauth";

  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [writeMode, setWriteMode] = useState<"append" | "replace">("append");
  const [deleteAllRevision, setDeleteAllRevision] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<SubmittedSecret[] | null>(null);
  // The committed-but-not-live report of this card's last write. The toast is
  // transient; this stays until the operator's next credential action.
  const [committedNotice, setCommittedNotice] = useState<string | null>(null);
  // The consumer revision an add or replacement whose answer was lost was
  // issued against. The write may have committed, so the kept draft cannot be
  // submitted again until the consumer has been re-read.
  const [unresolvedRevision, setUnresolvedRevision] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [deleteSelection, setDeleteSelection] = useState<{
    index: number; revision: number; snapshot: unknown;
  } | null>(null);

  const credentials = isBasic ? [] : normalizeCredentials(existingCredentials);
  const writePending = appendCredential.isPending || updateCredentials.isPending;
  const busy = writePending || deleteCredentials.isPending;
  const awaitingReread = unresolvedRevision !== null
    && (revision === unresolvedRevision || isRefreshing);
  const badgeVariant = CRED_BADGE_VARIANT[credentialType] ?? "default";

  if (!config) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          Unknown credential type: {credentialType}
        </p>
      </Card>
    );
  }

  /* ---------- Handlers ---------- */

  const openForm = (mode: "append" | "replace") => {
    setWriteMode(mode);
    setCommittedNotice(null);
    setUnresolvedRevision(null);
    setShowForm(true);
  };

  const reportCommitted = (message: string) => {
    setCommittedNotice(message);
    toast("warning", message);
  };

  const addCredential = session.bind(async () => {
    if (readOnly) return;
    if (busy || awaitingReread) return;
    let data;
    try {
      data = buildCredentialInput(credentialType, formValues);
      setErrors({});
    } catch (error) {
      if (error instanceof CredentialInputError) {
        const configuredField = config.fields.find((field) =>
          error.field.toLowerCase().includes(field.name.toLowerCase()),
        )?.name ?? config.fields[0]?.name ?? error.field;
        setErrors({ [configuredField]: error.message });
        return;
      }
      throw error;
    }

    setCommittedNotice(null);
    try {
      const mutation = writeMode === "replace" ? updateCredentials : appendCredential;
      const outcome = await mutation.mutateAsync({
        consumerId,
        credType: credentialType,
        data,
      });
      if (!mounted.current) return;
      // A committed-but-not-live answer completes the form exactly as a 2xx
      // does: the gateway holds the credential, so the secret is shown once,
      // the draft is cleared, and the submit action goes away. Keeping the
      // form armed would let a second click write the same secret again (#451).
      const secrets = submittedSecrets({ [credentialType]: [data] });
      if (secrets.length > 0) setReceipt(secrets);
      const summary = writeMode === "replace"
        ? "Basic credentials replaced"
        : `${config.label} credential added`;
      if (outcome.committed) reportCommitted(committedWriteMessage(summary, outcome.committed));
      else toast("success", summary);
      setFormValues({});
      setErrors({});
      setUnresolvedRevision(null);
      setShowForm(false);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to add credential");
      if (!mounted.current) return;
      // Not a pre-commit failure: the gateway may hold this credential. Keep
      // the draft (it may be the only copy of a stored secret), but refuse to
      // resubmit it until the consumer has been re-read.
      if (isUnobservedWrite(err)) setUnresolvedRevision(revision);
      toast("error", message);
    } finally {
      appendCredential.reset();
      updateCredentials.reset();
    }
  });

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    void addCredential();
  };

  const handleDelete = session.bind(async () => {
    if (readOnly) return;
    if (!deleteSelection) return;
    if (isRefreshing || deleteSelection.revision !== revision || deleteSelection.snapshot !== existingCredentials) {
      setDeleteSelection(null);
      toast("warning", "The credential list refreshed. Select the credential again before deleting it.");
      return;
    }
    setCommittedNotice(null);
    try {
      const outcome = await deleteCredentialByIndex.mutateAsync({
        consumerId,
        credType: credentialType,
        index: deleteSelection.index,
      });
      if (!mounted.current) return;
      const summary = `${config.label} credential removed`;
      if (outcome.committed) reportCommitted(committedWriteMessage(summary, outcome.committed));
      else toast("success", summary);
      setDeleteSelection(null);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to delete credential");
      if (!mounted.current) return;
      // A lost answer may already have removed this index; confirming it again
      // could remove the credential that moved into its place. Require a fresh
      // selection from the re-read list.
      if (isUnobservedWrite(err)) setDeleteSelection(null);
      toast("error", message);
    } finally {
      deleteCredentialByIndex.reset();
    }
  });

  const handleDeleteAll = session.bind(async () => {
    if (readOnly) return;
    if (deleteAllRevision === null || busy) return;
    if (isRefreshing || deleteAllRevision !== revision) {
      setDeleteAllRevision(null);
      toast("warning", "The consumer refreshed. Confirm deletion of all basic credentials again.");
      return;
    }
    setCommittedNotice(null);
    try {
      const outcome = await deleteCredentials.mutateAsync({ consumerId, credType: "basicauth" });
      if (!mounted.current) return;
      setDeleteAllRevision(null);
      setReceipt(null);
      setFormValues({});
      const summary = "All basic credentials deleted";
      if (outcome.committed) reportCommitted(committedWriteMessage(summary, outcome.committed));
      else toast("success", summary);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to delete basic credentials");
      if (!mounted.current) return;
      if (isUnobservedWrite(err)) setDeleteAllRevision(null);
      toast("error", message);
    } finally {
      deleteCredentials.reset();
    }
  });

  /* ---------- Render ---------- */

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-text-primary">
            {config.label}
          </h4>
          <Badge variant={badgeVariant}>{isBasic ? "Unknown" : credentials.length}</Badge>
        </div>
        {!showForm && !receipt && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => openForm("append")}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add
          </Button>
        )}
      </div>

      {isBasic && (
        <>
          <p className="text-text-muted text-sm py-2">
            Basic credential presence and count are unknown. The gateway omits
            basic credentials from ordinary consumer responses, even when configured.
            Basic authentication uses this consumer’s username; enter only a password.
          </p>
          {!showForm && !receipt && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => openForm("replace")}>
                Replace basic credentials
              </Button>
              <Button size="sm" variant="danger" disabled={busy || isRefreshing}
                onClick={() => setDeleteAllRevision(revision)}>
                Delete all basic credentials
              </Button>
            </div>
          )}
        </>
      )}

      {/* Existing credentials */}
      {credentials.length > 0 && (
        <div className="space-y-2">
          {credentials.map((cred, index) => (
            <div
              key={index}
              className="flex items-center justify-between bg-bg-primary/50 border border-border/50 rounded-lg px-4 py-2.5"
            >
              <span className="text-sm text-text-secondary font-mono">
                {renderCredentialSummary(credentialType, cred)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${config.label} credential ${index + 1}`}
                onClick={() => setDeleteSelection({ index, revision, snapshot: existingCredentials })}
                disabled={isRefreshing || deleteCredentialByIndex.isPending}
              >
                <svg
                  className="w-4 h-4 text-danger"
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
              </Button>
            </div>
          ))}
        </div>
      )}

      {!isBasic && credentials.length === 0 && !showForm && (
        <p className="text-text-muted text-sm py-2">
          No {config.label.toLowerCase()} credentials configured.
        </p>
      )}

      {committedNotice && (
        <p role="status" className="text-sm text-warning">
          {committedNotice}
        </p>
      )}

      {receipt && <CredentialCopyOnce secrets={receipt} onDone={() => setReceipt(null)} />}

      {/* Add credential form */}
      {showForm && (
        <form
          onSubmit={handleAdd}
          className="border border-border rounded-lg p-4 space-y-4 bg-bg-primary/30"
        >
          {isBasic && (
            <p className="text-sm text-text-secondary">
              {writeMode === "replace"
                ? "Replaces every existing basic password for this consumer with this password. Existing passwords will stop working."
                : "Adds another basic password while preserving existing passwords. Their count is not observable."}
            </p>
          )}
          {unresolvedRevision !== null && (
            <p role="alert" className="text-sm text-warning">
              {awaitingReread
                ? "Outcome unknown: the gateway may already hold this credential. Submitting it again is disabled until the consumer has been re-read."
                : "Outcome unknown: the gateway may already hold this credential. The consumer has been re-read; confirm the credential is not already present before submitting it again."}
            </p>
          )}
          {config.fields.map((field) => (
            <Input
              key={field.name}
              label={field.label}
              type={field.type ?? "text"}
              value={formValues[field.name] ?? ""}
              onChange={(e) =>
                setFormValues((prev) => ({
                  ...prev,
                  [field.name]: e.target.value,
                }))
              }
              placeholder={field.placeholder}
              helpText={field.helpText}
              error={errors[field.name]}
              disabled={writePending}
            />
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="submit"
              size="sm"
              loading={writePending}
              disabled={awaitingReread}
            >
              {writeMode === "replace" ? "Replace basic credentials" : "Add Credential"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setShowForm(false);
                setFormValues({});
                setErrors({});
                setUnresolvedRevision(null);
              }}
              disabled={writePending}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteSelection !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteSelection(null);
        }}
        title={`Delete ${config.label} Credential`}
        description={`Are you sure you want to delete this credential? This action cannot be undone.`}
        confirmLabel="Delete Credential"
        variant="danger"
        onConfirm={handleDelete}
        loading={deleteCredentialByIndex.isPending || isRefreshing}
      />
      <ConfirmDialog
        open={deleteAllRevision !== null}
        onOpenChange={(open) => { if (!open) setDeleteAllRevision(null); }}
        title="Delete all basic credentials"
        description={`Delete every basic password for consumer ${consumerId} in namespace ${session.identity.namespace}? The gateway does not reveal how many exist. All existing basic passwords will stop working. Other credential types are preserved. This cannot be undone.`}
        confirmLabel="Delete all basic credentials"
        variant="danger"
        onConfirm={handleDeleteAll}
        loading={deleteCredentials.isPending || isRefreshing}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exports for use in the detail page                                 */
/* ------------------------------------------------------------------ */

export const CREDENTIAL_TYPES = Object.keys(CREDENTIAL_CONFIGS) as BuiltInCredentialType[];
export const CREDENTIAL_LABELS = Object.fromEntries(
  Object.entries(CREDENTIAL_CONFIGS).map(([k, v]) => [k, v.label]),
);
