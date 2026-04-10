/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Circuit breaker status panel                      */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { Badge } from "@/components/ui/Badge";

interface CircuitBreakerPanelProps {
  breakers: AdminMetrics["circuit_breakers"];
}

function stateVariant(state: string): "green" | "red" | "yellow" | "default" {
  switch (state) {
    case "closed":
      return "green";
    case "open":
      return "red";
    case "half_open":
      return "yellow";
    default:
      return "default";
  }
}

export function CircuitBreakerPanel({ breakers }: CircuitBreakerPanelProps) {
  if (breakers.length === 0) {
    return (
      <p className="text-text-muted text-sm">No active circuit breakers</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-secondary text-xs border-b border-border">
            <th className="text-left py-2 pr-4 font-medium">Proxy ID</th>
            <th className="text-left py-2 pr-4 font-medium">State</th>
            <th className="text-right py-2 pr-4 font-medium">Failures</th>
            <th className="text-right py-2 font-medium">Successes</th>
          </tr>
        </thead>
        <tbody>
          {breakers.map((cb) => (
            <tr key={cb.proxy_id} className="border-b border-border/50">
              <td className="py-2 pr-4 text-text-primary font-mono text-xs">
                {cb.proxy_id}
              </td>
              <td className="py-2 pr-4">
                <Badge variant={stateVariant(cb.state)}>{cb.state}</Badge>
              </td>
              <td className="py-2 pr-4 text-right text-text-primary">
                {cb.failure_count}
              </td>
              <td className="py-2 text-right text-text-primary">
                {cb.success_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
