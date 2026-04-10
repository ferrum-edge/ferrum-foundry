/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Proxy page                                 */
/* ------------------------------------------------------------------ */

import { useNavigate } from "@tanstack/react-router";
import { useCreateProxy } from "@/hooks/useProxies";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { ProxyForm } from "@/components/forms/ProxyForm";
import { getApiErrorMessage } from "@/api/client";
import type { ProxyCreate } from "@/api/types";

export default function ProxyNewPage() {
  const navigate = useNavigate();
  const createProxy = useCreateProxy();
  const { toast } = useToast();

  const handleSubmit = async (data: ProxyCreate) => {
    try {
      const created = await createProxy.mutateAsync(data);
      toast("success", "Proxy created successfully");
      navigate({
        to: "/proxies/$proxyId",
        params: { proxyId: created.id },
      });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to create proxy");
      toast("error", message);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Create Proxy</h1>
        <p className="text-text-muted text-sm mt-1">
          Configure a new proxy route with upstream targets and settings.
        </p>
      </div>

      <Card>
        <ProxyForm onSubmit={handleSubmit} isLoading={createProxy.isPending} />
      </Card>
    </div>
  );
}
