import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ConsumerCredentials } from "@/api/types";

export interface SubmittedSecret {
  label: string;
  value: string;
}

/** Select only submitted secrets, never redacted response data or mTLS identities. */
export function submittedSecrets(credentials?: ConsumerCredentials): SubmittedSecret[] {
  const fields = [
    ["keyauth", "key", "API key"],
    ["basicauth", "password", "Basic auth password"],
    ["jwt", "secret", "JWT secret"],
    ["hmac_auth", "secret", "HMAC secret"],
  ] as const;
  return fields.flatMap(([type, field, label]) =>
    (credentials?.[type] ?? []).flatMap((entry, index) => {
      const value = (entry as unknown as Record<string, unknown>)[field];
      return typeof value === "string" && value !== "[REDACTED]"
        ? [{ label: `${label} ${index + 1}`, value }] : [];
    }),
  );
}

export function CredentialCopyOnce({ secrets, onDone }: {
  secrets: SubmittedSecret[];
  onDone: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const prefix = useId();
  return (
    <section aria-label="Save submitted credentials" className="space-y-4 py-4">
      <h2 className="text-lg font-semibold text-text-primary">Save your credentials</h2>
      <p className="text-sm text-text-secondary">
        These submitted secrets are shown once after saving. Copy them to your
        secure credential store before continuing. Later reads redact or omit
        them; leaving this page, changing namespace, or signing out clears this view.
      </p>
      {secrets.map((secret, index) => (
        <div key={secret.label} className="space-y-2">
          <label htmlFor={`${prefix}-secret-${index}`} className="text-sm text-text-secondary">{secret.label}</label>
          <textarea id={`${prefix}-secret-${index}`} aria-label={secret.label}
            readOnly value={secret.value} autoComplete="off" spellCheck={false}
            className="w-full rounded-lg border border-border bg-bg-input p-3 font-mono text-sm text-text-primary" />
          <Button type="button" size="sm" variant="secondary" onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret.value);
              setCopyStatus(`${secret.label} copied.`);
            } catch {
              setCopyStatus("Clipboard unavailable. Select the value and copy it manually before continuing.");
            }
          }}>Copy {secret.label}</Button>
        </div>
      ))}
      <p role="status" className="text-sm text-text-muted">{copyStatus}</p>
      <Button type="button" onClick={onDone}>I have saved these credentials</Button>
    </section>
  );
}
