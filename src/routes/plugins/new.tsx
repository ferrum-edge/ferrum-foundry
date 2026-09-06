/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Plugin Config page                         */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useAvailablePlugins,
  useCreatePluginWithMembership,
} from "@/hooks/usePlugins";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import { PluginMembershipRecovery } from "@/components/forms/PluginMembershipRecovery";
import type { PluginFormDefaults } from "@/components/forms/PluginConfigForm";
import { getApiErrorMessage } from "@/api/client";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import type { PluginConfigCreate } from "@/api/types";

export default function PluginNewPage() {
  const { toast } = useToast();
  const session = useEditorIdentity("new-plugins", {
    onStale: () => toast("warning", STALE_EDITOR_MESSAGE),
  });

  const [initialNamespace] = useState(session.identity.namespace);

  return (
    <PluginCreateEditor
      key={session.key}
      session={session}
      allowProxyDefault={session.identity.namespace === initialNamespace}
    />
  );
}

function PluginCreateEditor({ session, allowProxyDefault }: {
  session: EditorSession;
  allowProxyDefault: boolean;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const proxyId = allowProxyDefault ? search.proxyId : undefined;
  const createPlugin = useCreatePluginWithMembership();
  const { toast } = useToast();
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();

  const handleSubmit = session.bind(async (data: PluginConfigCreate, proxyGroupIds?: string[]) => {
    try {
      const created = await createPlugin.mutateAsync({
        data,
        proxyIds: proxyGroupIds ?? [],
      });

      toast("success", "Plugin configuration created successfully");
      navigate({
        to: "/plugins/$pluginId",
        params: { pluginId: created.id },
      });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(
        err,
        "Failed to create plugin configuration",
      );
      toast("error", message);
    }
  });

  if (pluginsLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Create Plugin</h1>
        <p className="text-text-muted text-sm mt-1">
          Add a new plugin instance and configure its settings.
        </p>
      </div>

      <PluginMembershipRecovery error={createPlugin.error} />
      <Card>
        <PluginConfigForm
          onSubmit={handleSubmit}
          isLoading={createPlugin.isPending}
          availablePlugins={availablePlugins ?? []}
          defaults={{
            pluginName: search.plugin ?? undefined,
            scope: search.scope === "proxy_group"
              ? "proxy_group"
              : search.scope === "proxy"
                ? "proxy"
                : proxyId
                  ? "proxy"
                  : undefined,
            proxyId,
          } satisfies PluginFormDefaults}
        />
      </Card>
    </div>
  );
}
