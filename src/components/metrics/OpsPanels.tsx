/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Overload, runtime, and chargeback metric panels   */
/* ------------------------------------------------------------------ */

import { Badge } from "@/components/ui/Badge";
import { StatCard } from "./StatCard";
import { MetricsSampleTime } from "./MetricsSampleTime";

import type { ChargebackSinkStatusResponse, PressureGauge } from "@/api/ops";
import {
  useOverload,
  useRuntimeMetrics,
  useCharges,
  useChargebackSinkStatus,
} from "@/hooks/useOps";
import { formatDateTime } from "@/lib/format";
import { isReadDenied, ReadDeniedNotice } from "@/components/shared/ReadState";

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

function pressureRow(
  label: string,
  gauge: PressureGauge & { enforced?: boolean },
  copy?: { disabled?: string; unconfigured?: string },
) {
  if (gauge.enforced === false) {
    return (
      <div key={label}>
        <div className="flex items-center justify-between gap-2 text-xs mb-1">
          <span className="text-text-secondary">{label}</span>
          <span className="flex items-center gap-2">
            <Badge variant="yellow">not enforced</Badge>
            <span className="text-text-muted tabular-nums">{gauge.current} open</span>
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {copy?.disabled ??
            "Load shedding for this limit is disabled because no enforceable ceiling could be determined."}
        </p>
      </div>
    );
  }
  if (gauge.max === 0) {
    return (
      <div key={label}>
        <div className="flex items-center justify-between gap-2 text-xs mb-1">
          <span className="text-text-secondary">{label}</span>
          <span className="flex items-center gap-2">
            <Badge variant="default">no limit configured</Badge>
            <span className="text-text-muted tabular-nums">{gauge.current}</span>
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {copy?.unconfigured ?? "No capacity limit is configured for this gauge."}
        </p>
      </div>
    );
  }
  return ratioBar(label, gauge.current, gauge.max);
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
            pressureRow("File descriptors", data.pressure.file_descriptors, {
              disabled:
                "FD-based load shedding is disabled because no enforceable descriptor ceiling could be determined. Connection and request limits are unaffected.",
            })}
          {data.pressure.connections &&
            pressureRow("Connections", data.pressure.connections, {
              unconfigured: "No connection limit is configured.",
            })}
          {data.pressure.requests &&
            pressureRow("In-flight requests", data.pressure.requests, {
              unconfigured: "No in-flight request limit is configured.",
            })}
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
      {/* Four across only where the panel is wide enough for "392.9 MB". */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4 gap-3">
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

/* ---------- Chargeback sink delivery ---------- */

function count(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}

/**
 * Recorded loss or a condition the operator must act on, from the sink's
 * process-lifetime totals. Cumulative counters survive recovery, so a
 * finding is history to reconcile, not necessarily a current failure.
 */
export function chargebackSinkFindings(status: ChargebackSinkStatusResponse): string[] {
  const { totals } = status;
  const findings: string[] = [];
  // `totals.spool.available` is false whenever no live instance enables a
  // spool (Edge reports `spool_enabled_any && spool_all_available`), and an
  // instance's `available` is false whenever its spool is disabled. Only an
  // enabled spool that is unavailable is a storage fault.
  const unwritable = status.instances.filter(
    (instance) => instance.spool.enabled === true && instance.spool.available === false,
  ).length;
  if (unwritable > 0) {
    findings.push(`Spool storage is not writable on ${count(unwritable)} spool-enabled instance${unwritable === 1 ? "" : "s"}`);
  }
  // Counts ClickHouse delivery failures and local snapshot spool handoff
  // failures alike; each instance's last failure reason says which.
  if ((totals.export.failures_total ?? 0) > 0) findings.push(`${count(totals.export.failures_total)} sink delivery failures`);
  if (totals.per_event.dropped_total > 0) findings.push(`${count(totals.per_event.dropped_total)} charge rows dropped before acknowledgement or spooling`);
  if ((totals.queue.full_drops_total ?? 0) > 0) findings.push(`${count(totals.queue.full_drops_total)} events dropped on a full queue`);
  if ((totals.spool.drops_total ?? 0) > 0) findings.push(`${count(totals.spool.drops_total)} spool drops`);
  if ((totals.spool.dead_letter_rows_total ?? 0) > 0) findings.push(`${count(totals.spool.dead_letter_rows_total)} rows dead-lettered as permanently rejected`);
  if ((totals.spool.unbound_files ?? 0) > 0) findings.push(`${count(totals.spool.unbound_files)} spool records not bound to a live destination (never replayed automatically)`);
  if (status.snapshot_finalizations_pending > 0) {
    findings.push(`${count(status.snapshot_finalizations_pending)} snapshot finalizations pending recovery`);
  }
  return findings;
}

/**
 * Read-only `api_chargeback_sink` delivery status (`GET /charges/sink/status`).
 * Like the chargeback totals it is fleet-global, so it lives on the Metrics
 * page that `FleetViewGate` withholds from namespace-scoped sessions.
 */
export function ChargebackSinkPanel({ refetchInterval }: RefreshPolicy = {}) {
  const { data, error, isLoading, isError, dataUpdatedAt } = useChargebackSinkStatus(refetchInterval);

  if (isLoading) return <p className="text-text-muted text-sm">Loading…</p>;
  // A 403 is an authorization denial, never "unavailable" or an idle sink.
  if (isError && isReadDenied(error)) return <ReadDeniedNotice label="Chargeback sink status" />;
  if (isError || !data)
    return (
      <>
        <MetricsSampleTime timestamp={dataUpdatedAt} />
        <p className="text-text-muted text-sm">
          Sink delivery status unavailable. The latest api_chargeback_sink status could not be retrieved.
        </p>
      </>
    );

  const findings = chargebackSinkFindings(data);
  const findingList = findings.length > 0 && (
    <div className="space-y-1" role="status">
      <h4 className="text-text-secondary text-xs font-medium">Recorded since the gateway process started</h4>
      <ul className="list-disc pl-5 text-xs text-warning space-y-0.5">
        {findings.map((finding) => <li key={finding}>{finding}</li>)}
      </ul>
      {data.snapshot_finalizations_pending > 0 && (
        <p className="text-xs text-text-muted">{data.snapshot_finalization_recovery_policy}</p>
      )}
    </div>
  );

  if (data.instance_count === 0) {
    return (
      <div className="space-y-3">
        <MetricsSampleTime timestamp={dataUpdatedAt} />
        <p className="text-text-muted text-sm">No api_chargeback_sink instance is live on this gateway.</p>
        {findingList}
      </div>
    );
  }

  const queue = data.totals.queue;
  return (
    <div className="space-y-4">
      <MetricsSampleTime timestamp={dataUpdatedAt} />
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4 gap-3">
        <StatCard label="Live instances" value={data.instance_count} />
        <StatCard label="Queue" value={queue.capacity ? `${count(queue.depth)} / ${count(queue.capacity)}` : count(queue.depth)} />
        <StatCard label="Rows exported" value={count(data.totals.export.events_exported_total)} />
        <StatCard label="Rows pending" value={count(data.totals.per_event.pending)} />
      </div>
      {findingList || (
        <p className="text-xs text-text-muted">No export failure, drop, dead letter, or unbound spool record recorded since the gateway process started.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary text-xs border-b border-border">
              <th className="text-left py-2 pr-4 font-medium">Plugin config</th>
              <th className="text-left py-2 pr-4 font-medium">Mode</th>
              <th className="text-left py-2 pr-4 font-medium">ClickHouse</th>
              <th className="text-left py-2 pr-4 font-medium">Spool</th>
              <th className="text-left py-2 font-medium">Last export</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((instance) => (
              <tr key={instance.plugin_config_id} className="border-b border-border/50 align-top">
                <td className="py-2 pr-4 text-text-primary font-mono text-xs">{instance.plugin_config_id}</td>
                <td className="py-2 pr-4 text-text-primary text-xs">{instance.mode.replace("_", "-")}</td>
                <td className="py-2 pr-4 text-xs">
                  <span className="font-mono text-text-primary">{instance.clickhouse.endpoint ?? "—"}</span>
                  {instance.clickhouse.table && (
                    <span className="block text-text-muted">
                      {instance.clickhouse.database ? `${instance.clickhouse.database}.` : ""}{instance.clickhouse.table}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-xs">
                  {instance.spool.enabled === false ? (
                    <Badge variant="default">disabled</Badge>
                  ) : instance.spool.available === false ? (
                    <Badge variant="red">unavailable</Badge>
                  ) : (
                    <Badge variant="green">available</Badge>
                  )}
                </td>
                <td className="py-2 text-xs">
                  <span className="block text-text-primary">
                    {instance.export.last_success_at ? `Succeeded ${formatDateTime(instance.export.last_success_at)}` : "No success recorded"}
                  </span>
                  {instance.export.last_failure_at && (
                    <span className="block text-danger">
                      Failed {formatDateTime(instance.export.last_failure_at)}
                      {instance.export.last_failure_reason ? `: ${instance.export.last_failure_reason}` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted">
        Instance values cover each plugin configuration&apos;s current generation; totals are cumulative for the gateway process and reset when it restarts.
      </p>
    </div>
  );
}
