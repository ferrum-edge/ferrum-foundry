/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Create Consumer page                              */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from "react";
import { CredentialCopyOnce, submittedSecrets, type SubmittedSecret } from "@/components/forms/CredentialCopyOnce";
import { useNavigate } from "@tanstack/react-router";
import { useCreateConsumer } from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/shared/PageHeader";
import { ConsumerForm } from "@/components/forms/ConsumerForm";
import { committedWriteMessage, getApiErrorMessage, getCommittedWrite } from "@/api/client";
import { useEditorIdentity, type EditorSession } from "@/hooks/useEditorIdentity";
import { useCapabilities } from "@/stores/capabilities";
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
  // `id` is null after a committed create, whose answer carries no body.
  const [receipt, setReceipt] = useState<{ id: string | null; secrets: SubmittedSecret[] } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const { toast } = useToast();
  const { capabilities } = useCapabilities();
  const capability = capabilities.consumers;

  const handleSubmit = session.bind(async (data: ConsumerCreate) => {
    if (!capability.allowed) return;
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
      // A committed-but-not-live answer is a completed create (#674), as for
      // a credential card: the submitted secrets are shown once and the form
      // goes away, so a second click cannot POST it again. The answer has no
      // body, so the new consumer is opened from the list.
      const committed = getCommittedWrite(err);
      if (committed) {
        if (!mounted.current) return;
        toast("warning", committedWriteMessage("Consumer created", committed));
        if (secrets.length > 0) {
          setReceipt({ id: null, secrets });
          return;
        }
        navigate({ to: "/consumers" });
        return;
      }
      const message = await getApiErrorMessage(err, "Failed to create consumer");
      if (mounted.current) toast("error", message);
    } finally {
      createConsumer.reset?.();
    }
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Create Consumer"
        description="Register a new API consumer with authentication credentials."
        breadcrumbs={[{ label: "Consumers", to: "/consumers" }, { label: "New consumer" }]}
      />

      <Card>
        {receipt ? (
          <CredentialCopyOnce secrets={receipt.secrets} onDone={() => {
            const id = receipt.id;
            setReceipt(null);
            if (id === null) navigate({ to: "/consumers" });
            else navigate({ to: "/consumers/$consumerId", params: { consumerId: id } });
          }} />
        ) : (
          <ConsumerForm
            onSubmit={handleSubmit}
            isLoading={createConsumer.isPending}
            capability={capability}
          />
        )}
      </Card>
    </div>
  );
}
