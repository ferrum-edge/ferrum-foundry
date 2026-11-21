import { PluginMembershipError, PluginSavedUnverifiedError } from "@/lib/pluginMembership";
import { REDACTED_PLACEHOLDER } from "@/api/maskedSecrets";
import { pluginTriggerWithheldSites, redactPluginTrigger } from "@/lib/resourceBaseline";

export function PluginMembershipRecovery({ error }: { error: unknown }) {
  if (!(error instanceof PluginMembershipError)) return null;
  // A committed save whose attachment could not be verified (#610) is a
  // warning, and its snapshot is what the gateway holds now.
  const saved = error instanceof PluginSavedUnverifiedError;
  const observed = saved && error.savedFromLaterRead;
  // Shown with its trigger as Edge main projects it: the header, query and
  // cookie operands are shared values, and this is page text. The marker is
  // Edge's own `[REDACTED]`, so this JSON pasted back into an editor is
  // blocked by its placeholder guard rather than saved with the marker as an
  // operand. The membership plan keeps the original snapshot for rollback.
  const snapshot = error.lastKnownConfig;
  const shown = snapshot && snapshot.trigger !== undefined && snapshot.trigger !== null
    ? { ...snapshot, trigger: redactPluginTrigger(snapshot.trigger, REDACTED_PLACEHOLDER) }
    : snapshot;
  // Said whenever a site is withheld, a gateway's own `[REDACTED]` included.
  const triggerRedacted = pluginTriggerWithheldSites(snapshot?.trigger ?? null)
    .some((site) => site.value !== "");

  return (
    <div
      role="alert"
      className={`space-y-3 rounded-lg border p-4 ${saved ? "border-warning/30" : "border-danger/30"}`}
    >
      <p className={`text-sm ${saved ? "text-warning" : "text-danger"}`}>{error.message}</p>
      {error.lastKnownConfig && (
        <details>
          <summary className="cursor-pointer text-sm text-text-primary">
            {observed
              ? "Configuration read after this save"
              : saved
                ? "Committed configuration"
                : "Saved configuration for recovery"}
          </summary>
          <p className="my-2 text-xs text-text-secondary">
            {observed
              ? "The gateway committed this save without returning it, so this is what a later " +
                "read showed. It may already include another operator's change, or lag behind " +
                "the save. Nothing was rolled back. Review any redacted values before reusing it."
              : saved
              ? "This is the configuration the gateway accepted with this save, including its new " +
                "scope. Nothing was rolled back. Review any redacted values before reusing it."
              : "This is the configuration saved before the operation (or the newly created " +
                "configuration). If the plugin is missing, recreate it before restoring its proxy " +
                "memberships. Review any redacted values first."}
          </p>
          {triggerRedacted && (
            <p className="mb-2 text-xs text-warning">
              Trigger values shown as [REDACTED] are withheld from this page. Re-enter them
              before reusing this configuration.
            </p>
          )}
          <pre className="max-h-96 overflow-auto rounded bg-code-bg p-3 text-xs text-text-primary">
            {JSON.stringify(shown, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
