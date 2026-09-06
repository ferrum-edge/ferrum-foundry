/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Overload, runtime, and chargeback metric panels   */
/* ------------------------------------------------------------------ */

import { Badge } from "@/components/ui/Badge";
import { StatCard } from "./StatCard";
import { MetricsSampleTime } from "./MetricsSampleTime";

import { useOverload, useRuntimeMetrics, useCharges } from "@/hooks/useOps";

interface RefreshPolicy { refetchInterval?: number | false; }

function ratioBar(label: string, current: number, max: number) {
  const ratio = max > 0 ? Math.min(1, current / max) : 0;
  const color =
    ratio > 0.9 ? "bg-danger" : ratio > 0.7 ? "bg-warning" : "bg-success";
  return (
    <div key={label}>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-text-secondary">{label}</span>
        <span className="text-text-muted">
          {current} / {max}
        </span>
      </div>
      <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/* ---------- Overload ---------- */

export function OverloadPanel({ refetchInterval }: RefreshPolicy = {}) {
  const { data, isLoading, isError, dataUpdatedAt } = useOverload(refetchInterval);

  if (isLoading) return <p className="text-text-muted text-sm">Loading…</p>;
  if (isError || !data)
    return <><MetricsSampleTime timestamp={dataUpdatedAt} /><p className="text-text-muted text-sm">Overload state unavailable.</p></>;

  const levelVariant =
    data.level === "normal" ? "green" : data.level === "pressure" ? "yellow" : "red";

  return (
    <div className="space-y-4">
      <MetricsSampleTime timestamp={dataUpdatedAt} />
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant={levelVariant} className="px-3 py-1">
          {data.level.toUpperCase()}
        </Badge>
        {data.draining && <Badge variant="yellow">draining</Badge>}
        {data.actions?.reject_new_requests && (
          <Badge variant="red">rejecting requests</Badge>
        )}
        {data.actions?.reject_new_connections && (
          <Badge variant="red">rejecting connections</Badge>
        )}
        {data.actions?.disable_keepalive && (
          <Badge variant="yellow">keep-alive off</Badge>
        )}
        {data.message && <span className="text-xs text-text-muted">{data.message}</span>}
      </div>

      {data.pressure && (
        <div className="space-y-3">
          {data.pressure.file_descriptors &&
            ratioBar(
              "File descriptors",
              data.pressure.file_descriptors.current,
              data.pressure.file_descriptors.max,
            )}
          {data.pressure.connections &&
            ratioBar(
              "Connections",
              data.pressure.connections.current,
              data.pressure.connections.max,
            )}
          {data.pressure.requests &&
            ratioBar(
              "In-flight requests",
              data.pressure.requests.current,
              data.pressure.requests.max,
            )}
        </div>
      )}

      {(data.red_drop_probability_pct ?? 0) > 0 && (
        <p className="text-xs text-danger">
          RED drop probability: {data.red_drop_probability_pct}%
        </p>
      )}
    </div>
  );
}

/* ---------- Runtime ---------- */

function formatBytes(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function RuntimePanel({ refetchInterval }: RefreshPolicy = {}) {
  const { data, isLoading, isError, dataUpdatedAt } = useRuntimeMetrics(refetchInterval);

  if (isLoading) return <p className="text-text-muted text-sm">Loading…</p>;
  if (isError || !data)
    return <><MetricsSampleTime timestamp={dataUpdatedAt} /><p className="text-text-muted text-sm">Runtime metrics unavailable.</p></>;

  return (
    <div className="space-y-4">
      <MetricsSampleTime timestamp={dataUpdatedAt} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="CPU (process)"
          value={
            data.system?.cpu?.process_percent != null
              ? `${data.system.cpu.process_percent.toFixed(1)}%`
              : "—"
          }
        />
        <StatCard label="RSS" value={formatBytes(data.system?.memory?.rss_bytes)} />
        <StatCard
          label="RPS (1m)"
          value={data.http?.requests_per_second_1m ?? "—"}
        />
        <StatCard
          label="Active conns"
          value={data.connections?.active ?? "—"}
        />
      </div>
      {data.dns && (
        <p className="text-xs text-text-muted">
          DNS: {data.dns.cache_entries ?? 0} cached ·{" "}
          {((data.dns.hit_ratio ?? 0) * 100).toFixed(0)}% hit ratio ·{" "}
          {data.dns.errors ?? 0} errors
        </p>
      )}
      {data.errors?.by_class && Object.keys(data.errors.by_class).length > 0 && (
        <div>
          <h4 className="text-text-secondary text-xs font-medium mb-2">Errors by class</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(data.errors.by_class).map(([cls, counts]) => {
              const total =
                (counts.http ?? 0) + (counts.grpc ?? 0) + (counts.stream ?? 0) + (counts.body ?? 0);
              if (total === 0) return null;
              return (
                <Badge key={cls} variant="red">
                  {cls}: {total}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Chargeback ---------- */

/** Group thousands and cap at 4 decimals so 421875 and 1.02 read consistently. */
function formatCharge(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function ChargesPanel({ refetchInterval }: RefreshPolicy = {}) {
  const { data, isLoading, isError, dataUpdatedAt } = useCharges(refetchInterval);

  if (isLoading) return <p className="text-text-muted text-sm">Loading…</p>;
  if (isError || !data)
    return (
      <>
        <MetricsSampleTime timestamp={dataUpdatedAt} />
        <p className="text-text-muted text-sm">
          Chargeback unavailable. The latest usage totals could not be retrieved.
        </p>
      </>
    );

  const consumers = Object.entries(data.consumers ?? {});
  if (consumers.length === 0) {
    return <><MetricsSampleTime timestamp={dataUpdatedAt} /><p className="text-text-muted text-sm">No metered usage recorded yet.</p></>;
  }

  return (
    <div className="overflow-x-auto">
      <MetricsSampleTime timestamp={dataUpdatedAt} />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-secondary text-xs border-b border-border">
            <th className="text-left py-2 pr-4 font-medium">Consumer</th>
            <th className="text-right py-2 pr-4 font-medium">Calls</th>
            <th className="text-right py-2 font-medium">
              Charges {data.currency && data.currency !== "mixed" ? `(${data.currency})` : ""}
            </th>
          </tr>
        </thead>
        <tbody>
          {consumers.map(([name, entry]) => (
            <tr key={name} className="border-b border-border/50">
              <td className="py-2 pr-4 text-text-primary font-mono text-xs">{name}</td>
              <td className="py-2 pr-4 text-right text-text-primary tabular-nums">
                {(entry.total_calls ?? 0).toLocaleString()}
              </td>
              <td className="py-2 text-right text-text-primary tabular-nums">
                {entry.total_charges != null
                  ? formatCharge(entry.total_charges)
                  : entry.charges_by_currency
                    ? Object.entries(entry.charges_by_currency)
                        .map(([cur, c]) => `${formatCharge(c.total_charges ?? 0)} ${cur}`)
                        .join(" + ")
                    : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
