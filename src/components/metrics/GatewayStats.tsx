/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Gateway overview stats panel                      */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "./StatCard";

interface GatewayStatsProps {
  metrics: AdminMetrics["gateway"];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function statusCodeVariant(code: string): "green" | "yellow" | "red" | "blue" {
  if (code.startsWith("2")) return "green";
  if (code.startsWith("3")) return "blue";
  if (code.startsWith("4")) return "yellow";
  if (code.startsWith("5")) return "red";
  return "blue";
}

export function GatewayStats({ metrics }: GatewayStatsProps) {
  const statusCodes = Object.entries(metrics.status_codes_last_second);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Version" value={metrics.ferrum_version} />
        <StatCard label="Mode" value={metrics.mode} />
        <StatCard
          label="Uptime"
          value={formatUptime(metrics.uptime_seconds)}
        />
        <StatCard
          label="Requests/sec"
          value={metrics.requests_per_second_current.toFixed(1)}
        />
        <StatCard
          label="Config Source"
          value={metrics.config_source_status}
          variant={metrics.config_source_status === "ok" ? "success" : "warning"}
        />
        <StatCard label="Proxies" value={metrics.proxy_count} />
        <StatCard label="Consumers" value={metrics.consumer_count} />
        <StatCard label="Upstreams" value={metrics.upstream_count} />
        <StatCard label="Plugin Configs" value={metrics.plugin_config_count} />
        {metrics.config_last_updated_at && (
          <StatCard
            label="Config Updated"
            value={new Date(metrics.config_last_updated_at).toLocaleTimeString()}
            subtitle={new Date(metrics.config_last_updated_at).toLocaleDateString()}
          />
        )}
      </div>

      {statusCodes.length > 0 && (
        <div>
          <h4 className="text-text-secondary text-xs font-medium mb-2">
            Status Codes (last second)
          </h4>
          <div className="flex flex-wrap gap-2">
            {statusCodes.map(([code, count]) => (
              <Badge key={code} variant={statusCodeVariant(code)}>
                {code}: {count}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
