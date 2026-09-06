/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Connection pool stats panel                       */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { StatCard } from "./StatCard";

interface ConnectionPoolPanelProps {
  pools: AdminMetrics["connection_pools"];
}

export function ConnectionPoolPanel({ pools }: ConnectionPoolPanelProps) {
  if (!pools.http && !pools.grpc && !pools.http2 && !pools.http3) {
    return <p className="text-text-muted text-sm">Connection pool metrics are not reported by this gateway mode.</p>;
  }
  const httpEntries = Object.entries(pools.http?.entries_per_host ?? {});

  return (
    <div className="space-y-4">
      {/* HTTP pool overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="HTTP Pools" value={pools.http?.total_pools ?? "Not reported"} />
        <StatCard label="Max Idle/Host" value={pools.http?.max_idle_per_host ?? "Not reported"} />
        <StatCard
          label="Idle Timeout"
          value={pools.http ? `${pools.http.idle_timeout_seconds}s` : "Not reported"}
        />
      </div>

      {/* Entries per host */}
      {httpEntries.length > 0 && (
        <div>
          <h4 className="text-text-secondary text-xs font-medium mb-2">
            HTTP Entries per Host
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary text-xs border-b border-border">
                  <th className="text-left py-1.5 pr-4 font-medium">Host</th>
                  <th className="text-right py-1.5 font-medium">Entries</th>
                </tr>
              </thead>
              <tbody>
                {httpEntries.map(([host, count]) => (
                  <tr key={host} className="border-b border-border/50">
                    <td className="py-1.5 pr-4 text-text-primary font-mono text-xs">
                      {host}
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
      )}

      {/* Other protocol connections */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="gRPC Connections" value={pools.grpc?.total_connections ?? "Not reported"} />
        <StatCard label="HTTP/2 Connections" value={pools.http2?.total_connections ?? "Not reported"} />
        <StatCard label="HTTP/3 Connections" value={pools.http3?.total_connections ?? "Not reported"} />
      </div>
    </div>
  );
}
