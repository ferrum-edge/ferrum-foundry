/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Consumer page                              */
/* ------------------------------------------------------------------ */

import { useNavigate } from "@tanstack/react-router";
import { useCreateConsumer } from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { ConsumerForm } from "@/components/forms/ConsumerForm";
import type { ConsumerCreate } from "@/api/types";

export default function ConsumerNewPage() {
  const navigate = useNavigate();
  const createConsumer = useCreateConsumer();
  const { toast } = useToast();

  const handleSubmit = async (data: ConsumerCreate) => {
    try {
      const created = await createConsumer.mutateAsync(data);
      toast("success", "Consumer created successfully");
      navigate({
        to: "/consumers/$consumerId",
        params: { consumerId: created.id },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create consumer";
      toast("error", message);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">
          Create Consumer
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Register a new API consumer with authentication credentials.
        </p>
      </div>

      <Card>
        <ConsumerForm
          onSubmit={handleSubmit}
          isLoading={createConsumer.isPending}
        />
      </Card>
    </div>
  );
}
