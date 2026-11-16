/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health check status panel                         */
/* ------------------------------------------------------------------ */

import type { AdminMetrics, AdminMetricsUnhealthyTarget } from "@/api/types";
import { StatCard } from "./StatCard";
import { formatDateTime } from "@/lib/format";

/**
 * One unhealthy-target row: a target can be unhealthy for both check kinds,
 * in several namespaces, and under several upstreams or proxies at once.
 */
export function unhealthyTargetKey(t: AdminMetricsUnhealthyTarget): string {
  return `${t.namespace}:${t.type}:${t.upstream_id ?? t.proxy_id ?? ""}:${t.target}`;
}

interface HealthCheckPanelProps {
  healthCheck: AdminMetrics["health_check"];
  /** The payload is fleet-wide; rows from any other namespace are labelled. */
  selectedNamespace: string;
}

export function HealthCheckPanel({ healthCheck, selectedNamespace }: HealthCheckPanelProps) {
  const hasUnhealthy = healthCheck.unhealthy_target_count > 0;

  return (
    <div className="space-y-4">
      <StatCard
        label="Unhealthy Targets"
        value={healthCheck.unhealthy_target_count}
        variant={hasUnhealthy ? "danger" : "success"}
      />

      {hasUnhealthy && (
        <div>
          <h4 className="text-text-secondary text-xs font-medium mb-2">
            Unhealthy Targets
          </h4>
          <ul className="space-y-2">
            {healthCheck.unhealthy_targets.map((t) => (
              <li
                key={unhealthyTargetKey(t)}
                className="flex items-center justify-between gap-3 text-sm bg-danger/5 border border-danger/20 rounded-lg px-3 py-2"
              >
                <span className="text-text-primary font-mono text-xs min-w-0 break-all">
                  {t.target}
                  <span className="text-text-muted font-sans">
                    {" "}({t.type}{t.upstream_id ? ` · ${t.upstream_id}` : t.proxy_id ? ` · ${t.proxy_id}` : ""}
                    {t.namespace !== selectedNamespace ? ` · ns ${t.namespace}` : ""})
                  </span>
                </span>
                <span className="text-text-muted text-xs shrink-0">
                  since {formatDateTime(t.since_epoch_ms)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
