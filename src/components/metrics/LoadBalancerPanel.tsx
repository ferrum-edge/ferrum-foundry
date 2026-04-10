/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Load balancer active connections panel             */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";

interface LoadBalancerPanelProps {
  loadBalancers: AdminMetrics["load_balancers"];
}

export function LoadBalancerPanel({ loadBalancers }: LoadBalancerPanelProps) {
  const upstreams = Object.entries(loadBalancers.active_connections);

  if (upstreams.length === 0) {
    return (
      <p className="text-text-muted text-sm">No active load balancer connections</p>
    );
  }

  return (
    <div className="space-y-4">
      {upstreams.map(([upstreamId, targets]) => (
        <div key={upstreamId}>
          <h4 className="text-text-secondary text-xs font-medium mb-2">
            Upstream:{" "}
            <span className="text-text-primary font-mono">{upstreamId}</span>
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary text-xs border-b border-border">
                  <th className="text-left py-1.5 pr-4 font-medium">Target</th>
                  <th className="text-right py-1.5 font-medium">Connections</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(targets).map(([target, count]) => (
                  <tr key={target} className="border-b border-border/50">
                    <td className="py-1.5 pr-4 text-text-primary font-mono text-xs">
                      {target}
                    </td>
                    <td className="py-1.5 text-right text-text-primary">
                      {count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
