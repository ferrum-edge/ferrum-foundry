/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Gateway overview stats panel                      */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "./StatCard";
import { formatDateTime } from "@/lib/format";
import type { GatewayRequestStats } from "@/hooks/useGatewayRequestStats";

interface GatewayStatsProps {
  metrics: AdminMetrics["gateway"];
  requestStats: GatewayRequestStats;
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

const CONFIG_SOURCE_LABELS: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  "n/a": "Not applicable",
};

function formatRate(rate?: number): string {
  if (rate === undefined) return "Collecting";
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
}

export function GatewayStats({ metrics, requestStats }: GatewayStatsProps) {
  const hasStatusRates = requestStats.statusCodesPerSecond !== undefined;
  const statusCodes = Object.entries(metrics.status_codes_total)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-4">
      {/* Ten cards: two full rows of five on wide screens, pairs below. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Version" value={metrics.ferrum_version} />
        <StatCard label="Mode" value={metrics.mode} />
        <StatCard
          label="Uptime"
          value={formatUptime(metrics.uptime_seconds)}
        />
        <StatCard
          label="Requests/sec"
          value={formatRate(requestStats.requestsPerSecond)}
          subtitle={
            requestStats.requestsPerSecond === undefined
              ? "Waiting for next sample"
              : "Calculated from counter delta"
          }
        />
        <StatCard
          label="Total Requests"
          value={requestStats.totalRequests.toLocaleString()}
        />
        <StatCard label="Proxies" value={metrics.proxy_count} />
        <StatCard label="Consumers" value={metrics.consumer_count} />
        <StatCard label="Upstreams" value={metrics.upstream_count} />
        <StatCard label="Plugin Configs" value={metrics.plugin_config_count} />
        {/* Source status and last update describe one thing, so they share a
            card. Only an offline source is coloured: that is a warning. */}
        <StatCard
          label="Config Source"
          value={CONFIG_SOURCE_LABELS[metrics.config_source_status] ?? metrics.config_source_status}
          variant={metrics.config_source_status === "offline" ? "warning" : "default"}
          subtitle={
            metrics.config_last_updated_at
              ? `Updated ${formatDateTime(metrics.config_last_updated_at)}`
              : "Last update not reported"
          }
        />
      </div>

      {statusCodes.length > 0 && (
        <div>
          <h4 className="text-text-secondary text-xs font-medium mb-2">
            {hasStatusRates ? "Status Codes / sec" : "Status Code Totals"}
          </h4>
          <div className="flex flex-wrap gap-2">
            {statusCodes.map(([code, total]) => {
              const rate = requestStats.statusCodesPerSecond?.[code];
              return (
                <Badge key={code} variant={statusCodeVariant(code)}>
                  {code}: {rate === undefined ? total : `${formatRate(rate)}/s`}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
