/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Upstream page                              */
/* ------------------------------------------------------------------ */

import { useNavigate } from "@tanstack/react-router";
import { useCreateUpstream } from "@/hooks/useUpstreams";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { UpstreamForm } from "@/components/forms/UpstreamForm";
import { getApiErrorMessage } from "@/api/client";
import type { UpstreamCreate } from "@/api/types";

export default function UpstreamNewPage() {
  const navigate = useNavigate();
  const createUpstream = useCreateUpstream();
  const { toast } = useToast();

  const handleSubmit = async (data: UpstreamCreate) => {
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
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Create Upstream</h1>
        <p className="text-text-muted text-sm mt-1">
          Define a new upstream service with targets and health check configuration.
        </p>
      </div>

      <Card>
        <UpstreamForm onSubmit={handleSubmit} isLoading={createUpstream.isPending} />
      </Card>
    </div>
  );
}
