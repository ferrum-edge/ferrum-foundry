/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Upstream page                              */
/* ------------------------------------------------------------------ */

import { useNavigate } from "@tanstack/react-router";
import { useCreateUpstream } from "@/hooks/useUpstreams";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/shared/PageHeader";
import { UpstreamForm } from "@/components/forms/UpstreamForm";
import { getApiErrorMessage } from "@/api/client";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import { useCapabilities } from "@/stores/capabilities";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import type { UpstreamCreate } from "@/api/types";

export default function UpstreamNewPage() {
  const { toast } = useToast();
  const session = useEditorIdentity("new-upstreams", {
    onStale: () => toast("warning", STALE_EDITOR_MESSAGE),
  });

  return <UpstreamCreateEditor key={session.key} session={session} />;
}

function UpstreamCreateEditor({ session }: { session: EditorSession }) {
  const navigate = useNavigate();
  const createUpstream = useCreateUpstream();
  const { toast } = useToast();
  const { capabilities, facts } = useCapabilities();
  const capability = capabilities.upstreams;

  const handleSubmit = session.bind(async (data: UpstreamCreate) => {
    if (!capability.allowed) return;
    try {
      const created = await createUpstream.mutateAsync(data);
      toast("success", "Upstream created successfully");
      navigate({
        to: "/upstreams/$upstreamId",
        params: { upstreamId: created.id },
      });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to create upstream");
      toast("error", message);
    }
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Create Upstream"
        description="Define a new upstream service with targets and health check configuration."
        breadcrumbs={[{ label: "Upstreams", to: "/upstreams" }, { label: "New upstream" }]}
      />

      <Card>
        <UpstreamForm
          onSubmit={handleSubmit}
          isLoading={createUpstream.isPending}
          capability={capability}
          role={facts.role}
        />
      </Card>
    </div>
  );
}
