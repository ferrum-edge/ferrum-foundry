/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Plugin Config page                         */
/* ------------------------------------------------------------------ */

import { useNavigate } from "@tanstack/react-router";
import { useCreatePluginConfig, useAvailablePlugins } from "@/hooks/usePlugins";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import type { PluginConfigCreate } from "@/api/types";

export default function PluginNewPage() {
  const navigate = useNavigate();
  const createPlugin = useCreatePluginConfig();
  const { toast } = useToast();
  const { data: availablePlugins, isLoading: pluginsLoading } = useAvailablePlugins();

  const handleSubmit = async (data: PluginConfigCreate) => {
    try {
      const created = await createPlugin.mutateAsync(data);
      toast("success", "Plugin configuration created successfully");
      navigate({
        to: "/plugins/$pluginId",
        params: { pluginId: created.id },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create plugin configuration";
      toast("error", message);
    }
  };

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

      <Card>
        <PluginConfigForm
          onSubmit={handleSubmit}
          isLoading={createPlugin.isPending}
          availablePlugins={availablePlugins ?? []}
        />
      </Card>
    </div>
  );
}
