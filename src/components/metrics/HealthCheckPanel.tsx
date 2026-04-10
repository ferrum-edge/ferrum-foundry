/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health check status panel                         */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { StatCard } from "./StatCard";

interface HealthCheckPanelProps {
  healthCheck: AdminMetrics["health_check"];
}

export function HealthCheckPanel({ healthCheck }: HealthCheckPanelProps) {
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
                key={t.target}
                className="flex items-center justify-between text-sm bg-danger/5 border border-danger/20 rounded-lg px-3 py-2"
              >
                <span className="text-text-primary font-mono text-xs">
                  {t.target}
                </span>
                <span className="text-text-muted text-xs">
                  since {new Date(t.since_epoch_ms).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
