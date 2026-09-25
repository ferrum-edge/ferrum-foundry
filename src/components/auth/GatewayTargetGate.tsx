import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  GATEWAY_TARGET_CHANGED_MESSAGE,
  isGatewayTargetRetired,
  subscribeGatewayTarget,
} from "@/api/gatewayTarget";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Holds the workspace to the gateway target this page was opened against
 * (`src/api/gatewayTarget.ts`). Once that target is replaced the workspace is
 * unmounted — every editor, draft, confirmation, and capability observation
 * with it — and every cached read is discarded, so nothing observed on the old
 * gateway is presented as, or submitted to, the new one. Only a reload, which
 * binds the new target from scratch, leaves this state.
 */
export function GatewayTargetGate({
  children,
  onReload = () => window.location.reload(),
}: {
  children: ReactNode;
  onReload?: () => void;
}) {
  const queryClient = useQueryClient();
  const retired = useSyncExternalStore(subscribeGatewayTarget, isGatewayTargetRetired);

  useEffect(() => {
    if (retired) queryClient.clear();
  }, [queryClient, retired]);

  if (!retired) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary px-4">
      <Card className="w-full max-w-md">
        <h1 className="text-lg font-semibold text-text-primary mb-1">Gateway target changed</h1>
        <p className="text-text-muted text-sm mb-6" role="alert">
          {GATEWAY_TARGET_CHANGED_MESSAGE}
        </p>
        <Button className="w-full" onClick={onReload}>
          Reload Foundry
        </Button>
      </Card>
    </div>
  );
}
