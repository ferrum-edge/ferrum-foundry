/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Consumer page                              */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from "react";
import { CredentialCopyOnce, submittedSecrets, type SubmittedSecret } from "@/components/forms/CredentialCopyOnce";
import { useNavigate } from "@tanstack/react-router";
import { useCreateConsumer } from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { ConsumerForm } from "@/components/forms/ConsumerForm";
import { getApiErrorMessage } from "@/api/client";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import { STALE_EDITOR_MESSAGE } from "@/lib/editorIdentity";
import type { ConsumerCreate } from "@/api/types";

export default function ConsumerNewPage() {
  const { toast } = useToast();
  const session = useEditorIdentity("new-consumers", {
    onStale: () => toast("warning", STALE_EDITOR_MESSAGE),
  });

  return <ConsumerCreateEditor key={session.key} session={session} />;
}

function ConsumerCreateEditor({ session }: { session: EditorSession }) {
  const navigate = useNavigate();
  const createConsumer = useCreateConsumer();
  const [receipt, setReceipt] = useState<{ id: string; secrets: SubmittedSecret[] } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const { toast } = useToast();

  const handleSubmit = session.bind(async (data: ConsumerCreate) => {
    const secrets = submittedSecrets(data.credentials);
    try {
      const created = await createConsumer.mutateAsync(data);
      if (!mounted.current) return;
      toast("success", "Consumer created successfully");
      if (secrets.length > 0) {
        setReceipt({ id: created.id, secrets });
        return;
      }
      navigate({
        to: "/consumers/$consumerId",
        params: { consumerId: created.id },
      });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to create consumer");
      if (mounted.current) toast("error", message);
    } finally {
      createConsumer.reset?.();
    }
  });

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
        {receipt ? (
          <CredentialCopyOnce secrets={receipt.secrets} onDone={() => {
            const id = receipt.id;
            setReceipt(null);
            navigate({ to: "/consumers/$consumerId", params: { consumerId: id } });
          }} />
        ) : (
          <ConsumerForm onSubmit={handleSubmit} isLoading={createConsumer.isPending} />
        )}
      </Card>
    </div>
  );
}
