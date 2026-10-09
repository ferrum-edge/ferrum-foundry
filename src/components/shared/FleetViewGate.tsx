/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – fleet-wide views for namespace-scoped sessions   */
/*                                                                    */
/*  A page that only reads fleet-global routes (TLS, metrics,         */
/*  cluster, mesh) is refused route by route to a session holding     */
/*  namespace grants: by the BFF's namespace route ceiling, and by    */
/*  Ferrum Edge v0.9.16+ for an `ns`-claim JWT. Such a session gets   */
/*  the page title and the reason instead, and none of the page's     */
/*  reads is sent.                                                    */
/* ------------------------------------------------------------------ */

import type { ReactNode } from "react";
import { CapabilityNotice } from "@/components/shared/CapabilityGate";
import { PageHeader } from "@/components/shared/PageHeader";
import { resolveFleetView, type FleetView } from "@/lib/capabilities";
import { useCapabilities } from "@/stores/capabilities";

export function FleetViewGate({
  view,
  title,
  children,
}: {
  view: FleetView;
  title: string;
  children: ReactNode;
}) {
  const { facts } = useCapabilities();
  const verdict = resolveFleetView(view, facts);
  if (verdict.allowed) return <>{children}</>;
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <CapabilityNotice verdict={verdict} />
    </div>
  );
}
