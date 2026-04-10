/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Credential management per type                   */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useAppendCredential,
  useDeleteCredentialByIndex,
} from "@/hooks/useConsumers";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CredentialFormProps {
  consumerId: string;
  credentialType: string;
  existingCredentials?: unknown;
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
  "key-auth": {
    label: "Key Authentication",
    fields: [
      {
        name: "key",
        label: "API Key",
        placeholder: "Leave blank to auto-generate",
        required: false,
        helpText: "A unique API key. If left empty, one will be auto-generated.",
      },
    ],
  },
  basicauth: {
    label: "Basic Authentication",
    fields: [
      {
        name: "username",
        label: "Username",
        placeholder: "basic-auth-username",
        required: true,
      },
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
  "key-auth": "orange",
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
    case "key-auth":
      return cred.key ? `Key: ${maskString(String(cred.key))}` : "Key (auto-generated)";
    case "basicauth":
      return cred.username ? `User: ${String(cred.username)}` : "Basic auth credential";
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
  consumerId,
  credentialType,
  existingCredentials,
}: CredentialFormProps) {
  const config = CREDENTIAL_CONFIGS[credentialType];
  const { toast } = useToast();
  const appendCredential = useAppendCredential();
  const deleteCredentialByIndex = useDeleteCredentialByIndex();

  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

  const credentials = normalizeCredentials(existingCredentials);
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

  /* ---------- Validation ---------- */

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    for (const field of config.fields) {
      if (field.required && !formValues[field.name]?.trim()) {
        errs[field.name] = `${field.label} is required`;
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /* ---------- Handlers ---------- */

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const data: Record<string, string> = {};
    for (const field of config.fields) {
      const val = formValues[field.name]?.trim();
      if (val) data[field.name] = val;
    }

    try {
      await appendCredential.mutateAsync({
        consumerId,
        credType: credentialType,
        data,
      });
      toast("success", `${config.label} credential added`);
      setFormValues({});
      setErrors({});
      setShowForm(false);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to add credential");
      toast("error", message);
    }
  };

  const handleDelete = async () => {
    if (deleteIndex === null) return;
    try {
      await deleteCredentialByIndex.mutateAsync({
        consumerId,
        credType: credentialType,
        index: deleteIndex,
      });
      toast("success", `${config.label} credential removed`);
      setDeleteIndex(null);
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to delete credential");
      toast("error", message);
    }
  };

  /* ---------- Render ---------- */

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-text-primary">
            {config.label}
          </h4>
          <Badge variant={badgeVariant}>{credentials.length}</Badge>
        </div>
        {!showForm && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowForm(true)}
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
                onClick={() => setDeleteIndex(index)}
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

      {credentials.length === 0 && !showForm && (
        <p className="text-text-muted text-sm py-2">
          No {config.label.toLowerCase()} credentials configured.
        </p>
      )}

      {/* Add credential form */}
      {showForm && (
        <form
          onSubmit={handleAdd}
          className="border border-border rounded-lg p-4 space-y-4 bg-bg-primary/30"
        >
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
            />
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="submit"
              size="sm"
              loading={appendCredential.isPending}
            >
              Add Credential
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setShowForm(false);
                setFormValues({});
                setErrors({});
              }}
              disabled={appendCredential.isPending}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteIndex !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteIndex(null);
        }}
        title={`Delete ${config.label} Credential`}
        description={`Are you sure you want to delete this credential? This action cannot be undone.`}
        confirmLabel="Delete Credential"
        variant="danger"
        onConfirm={handleDelete}
        loading={deleteCredentialByIndex.isPending}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exports for use in the detail page                                 */
/* ------------------------------------------------------------------ */

export const CREDENTIAL_TYPES = Object.keys(CREDENTIAL_CONFIGS);
export const CREDENTIAL_LABELS = Object.fromEntries(
  Object.entries(CREDENTIAL_CONFIGS).map(([k, v]) => [k, v.label]),
);
