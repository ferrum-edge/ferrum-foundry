/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – proxy runtime values a gateway does not report    */
/* ------------------------------------------------------------------ */

import type { AdminMetricsReporting } from "@/lib/adminMetricsReporting";

interface ProxyRuntimeNoticeProps {
  reporting: AdminMetricsReporting;
}

/**
 * Stands in for the uptime, traffic and resource-count values a control plane
 * or node agent only reports as zero placeholders. Renders nothing for a mode
 * that measures them.
 */
export function ProxyRuntimeNotice({ reporting }: ProxyRuntimeNoticeProps) {
  if (reporting.reportsProxyRuntime) return null;
  return (
    <div className="bg-bg-card border border-border rounded-lg p-4" role="note">
      <p className="text-text-primary text-sm font-medium">
        Uptime, request traffic and resource counts: {reporting.unavailableLabel}
      </p>
      <p className="text-text-muted text-xs mt-1">{reporting.unavailableDetail}</p>
    </div>
  );
}
