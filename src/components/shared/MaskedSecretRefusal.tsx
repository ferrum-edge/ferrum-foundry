/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – a save refused over a masked-secret placeholder   */
/* ------------------------------------------------------------------ */

import { maskedPlaceholderRefusal } from "@/api/maskedSecrets";

/**
 * Lists the fields of a save that was refused because the body still carried
 * a placeholder the caller's read put in place of a stored secret: Edge's
 * `400` (ferrum-edge#5925), or Foundry's own refusal before sending. The JSON
 * pointers are shown exactly as reported; no value is.
 */
export function MaskedSecretRefusal({ error }: { error: unknown }) {
  const refusal = maskedPlaceholderRefusal(error);
  if (!refusal) return null;

  const reader = refusal.role ? `'${refusal.role}' reads` : "reads for your role";
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-danger/30 p-4">
      <p className="text-sm text-danger">
        {refusal.local ? "Foundry did not send this save" : "Ferrum Edge refused this save"}:
        these fields carry the placeholder that {reader} show in place of a stored
        secret. Re-enter each value, or clear it (clearing deletes the stored
        secret), or have an admin make the change.
      </p>
      <ul className="list-disc pl-5 text-xs text-text-primary">
        {refusal.pointers.map((pointer) => (
          <li key={pointer}>
            <code className="font-mono">{pointer}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
