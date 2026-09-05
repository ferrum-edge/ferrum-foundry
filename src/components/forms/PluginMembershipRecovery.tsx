import { PluginMembershipError } from "@/lib/pluginMembership";

export function PluginMembershipRecovery({ error }: { error: unknown }) {
  if (!(error instanceof PluginMembershipError)) return null;

  return (
    <div role="alert" className="space-y-3 rounded-lg border border-danger/30 p-4">
      <p className="text-sm text-danger">{error.message}</p>
      {error.lastKnownConfig && (
        <details>
          <summary className="cursor-pointer text-sm text-text-primary">
            Saved configuration for recovery
          </summary>
          <p className="my-2 text-xs text-text-secondary">
            This is the configuration saved before the operation (or the newly
            created configuration). If the plugin is missing, recreate it before
            restoring its proxy memberships. Review any redacted values first.
          </p>
          <pre className="max-h-96 overflow-auto rounded bg-code-bg p-3 text-xs text-text-primary">
            {JSON.stringify(error.lastKnownConfig, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
