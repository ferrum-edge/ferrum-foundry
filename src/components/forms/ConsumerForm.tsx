/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer create / edit form                      */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleSection } from "./CollapsibleSection";
import type { Consumer, ConsumerCreate } from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ConsumerFormProps {
  initialData?: Consumer;
  onSubmit: (data: ConsumerCreate) => Promise<void>;
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helper: Tag Input for ACL groups                                   */
/* ------------------------------------------------------------------ */

function TagInput({
  label,
  values,
  onChange,
  placeholder = "Type and press Enter",
  helpText,
}: {
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  helpText?: string;
}) {
  const [input, setInput] = useState("");

  const addTags = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const newValues = parts.filter((v) => !values.includes(v));
    if (newValues.length > 0) {
      onChange([...values, ...newValues]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(input);
      setInput("");
    }
    if (e.key === "Backspace" && input === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const handleBlur = () => {
    if (input.trim()) {
      addTags(input);
      setInput("");
    }
  };

  const removeTag = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="text-text-secondary text-sm font-medium">{label}</span>
      )}
      <div className="flex flex-wrap gap-1.5 bg-bg-input border border-border rounded-lg px-3 py-2 focus-within:border-orange focus-within:ring-1 focus-within:ring-orange/30 transition-colors duration-150">
        {values.map((v, i) => (
          <Badge key={`${v}-${i}`} variant="blue">
            <span className="flex items-center gap-1">
              {v}
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="text-text-muted hover:text-text-primary cursor-pointer"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </Badge>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={values.length === 0 ? placeholder : ""}
          className="bg-transparent text-text-primary text-sm outline-none flex-1 min-w-[80px] placeholder:text-text-muted"
        />
      </div>
      {helpText && <p className="text-text-muted text-xs">{helpText}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Credential type config                                             */
/* ------------------------------------------------------------------ */

const CREDENTIAL_TYPES = [
  { value: "keyauth", label: "Key Auth", field: "key", placeholder: "my-api-key", helpText: "API key for key_auth plugin", generatable: true },
  { value: "basicauth", label: "Basic Auth", field: "password", placeholder: "password", helpText: "Password (auto-hashed by the gateway)", generatable: true },
  { value: "jwt", label: "JWT", field: "secret", placeholder: "jwt-signing-secret", helpText: "HS256 signing secret for jwt_auth plugin", generatable: true },
  { value: "hmac_auth", label: "HMAC Auth", field: "secret", placeholder: "hmac-secret", helpText: "Shared secret for HMAC signature verification", generatable: true },
  { value: "mtls_auth", label: "mTLS Auth", field: "identity", placeholder: "CN=client.example.com", helpText: "Certificate field value to match against the client certificate", generatable: false },
] as const;

function generateSecret(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

type CredentialType = (typeof CREDENTIAL_TYPES)[number]["value"];

/* ================================================================== */
/*  ConsumerForm                                                       */
/* ================================================================== */

export function ConsumerForm({
  initialData,
  onSubmit,
  isLoading,
}: ConsumerFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;

  /* ---------- Form state ---------- */
  const [resourceId, setResourceId] = useState("");
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [customId, setCustomId] = useState(initialData?.custom_id ?? "");
  const [aclGroups, setAclGroups] = useState<string[]>(
    initialData?.acl_groups ?? [],
  );

  /* ---------- Credential state (create only) ---------- */
  const [credValues, setCredValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(CREDENTIAL_TYPES.map((t) => [t.value, ""])),
  );

  const updateCred = (type: string, value: string) => {
    setCredValues((prev) => ({ ...prev, [type]: value }));
  };

  const credentialCount = Object.values(credValues).filter((v) => v.trim()).length;

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!username.trim()) errs.username = "Username is required";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    // Build credentials object from all filled credential fields
    const credentials: Record<string, unknown> = {};
    for (const typeDef of CREDENTIAL_TYPES) {
      const val = credValues[typeDef.value]?.trim();
      if (val) {
        credentials[typeDef.value] = { [typeDef.field]: val };
      }
    }

    const data: ConsumerCreate = {
      ...(resourceId.trim() && { id: resourceId.trim() }),
      username: username.trim(),
      ...(customId.trim() && { custom_id: customId.trim() }),
      ...(aclGroups.length > 0 && { acl_groups: aclGroups }),
      ...(Object.keys(credentials).length > 0 && { credentials }),
    };

    await onSubmit(data);
  };

  /* ---------- Render ---------- */

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      <div className="py-4 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">
          Consumer Details
        </h3>
        {!isEdit && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="ID"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                placeholder="Auto-generated UUID if left blank"
                helpText="Optional custom ID. Must start with alphanumeric, max 254 chars."
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0 mb-[1px]"
              onClick={() => setResourceId(crypto.randomUUID())}
            >
              Generate UUID
            </Button>
          </div>
        )}
        <Input
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="my-api-consumer"
          error={errors.username}
          required
        />
        <Input
          label="Custom ID"
          value={customId}
          onChange={(e) => setCustomId(e.target.value)}
          placeholder="Optional external identifier"
          helpText="An optional identifier used to map the consumer to an external system"
        />
        <TagInput
          label="ACL Groups"
          values={aclGroups}
          onChange={setAclGroups}
          placeholder="group-name, press Enter to add"
          helpText="Access control groups this consumer belongs to. Comma-separated, press Enter to add."
        />
      </div>

      {/* Credentials (create mode only) */}
      {!isEdit && (
        <CollapsibleSection
          title="Credentials"
          badge={credentialCount > 0 ? String(credentialCount) : undefined}
        >
          <p className="text-text-muted text-xs mb-4">
            Fill in any credentials to attach to this consumer. Leave blank to skip.
          </p>
          <div className="space-y-4">
            {CREDENTIAL_TYPES.map((typeDef) => (
              <div key={typeDef.value} className="flex items-end gap-2">
                <div className="flex-1">
                  <Input
                    label={typeDef.label}
                    value={credValues[typeDef.value]}
                    onChange={(e) => updateCred(typeDef.value, e.target.value)}
                    placeholder={typeDef.placeholder}
                    helpText={typeDef.helpText}
                    type={typeDef.field === "password" || typeDef.field === "secret" ? "password" : "text"}
                  />
                </div>
                {typeDef.generatable && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0 mb-[1px]"
                    onClick={() => updateCred(typeDef.value, generateSecret())}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Generate
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-6 border-t border-border/50">
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate({ to: "/consumers" })}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" loading={isLoading}>
          {isEdit ? "Update Consumer" : "Create Consumer"}
        </Button>
      </div>
    </form>
  );
}
