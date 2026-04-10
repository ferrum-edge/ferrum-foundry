/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Parsed Prometheus metrics panel                   */
/* ------------------------------------------------------------------ */

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProxyRequestRow {
  proxyId: string;
  method: string;
  statusCode: string;
  count: number;
}

interface ProxyLatency {
  proxyId: string;
  kind: "request" | "backend" | "overhead";
  count: number;
  sum: number;
  p50: number | null;
  p99: number | null;
}

/* ------------------------------------------------------------------ */
/*  Parser                                                             */
/* ------------------------------------------------------------------ */

function parseRequestRows(text: string): ProxyRequestRow[] {
  const rows: ProxyRequestRow[] = [];
  const re =
    /^ferrum_requests_total\{proxy_id="([^"]*)",method="([^"]*)",status_code="(\d+)"[^}]*\}\s+(\d+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    rows.push({
      proxyId: match[1],
      method: match[2],
      statusCode: match[3],
      count: Number(match[4]),
    });
  }
  return rows.sort((a, b) => b.count - a.count);
}

function parseLatencyRows(text: string): ProxyLatency[] {
  const kinds = [
    { key: "ferrum_request_duration_ms", label: "request" as const },
    { key: "ferrum_backend_duration_ms", label: "backend" as const },
    { key: "ferrum_edge_overhead_ms", label: "overhead" as const },
  ];

  const rows: ProxyLatency[] = [];

  for (const { key, label } of kinds) {
    // sum lines
    const sumRe = new RegExp(
      `^${key}_sum\\{proxy_id="([^"]*)"[^}]*\\}\\s+([\\d.]+)`,
      "gm",
    );
    const countRe = new RegExp(
      `^${key}_count\\{proxy_id="([^"]*)"[^}]*\\}\\s+(\\d+)`,
      "gm",
    );
    const bucketRe = new RegExp(
      `^${key}_bucket\\{proxy_id="([^"]*)"[^}]*,le="([^"]*)"[^}]*\\}\\s+(\\d+)`,
      "gm",
    );

    const sums = new Map<string, number>();
    const counts = new Map<string, number>();
    const buckets = new Map<string, { le: number; count: number }[]>();

    let m: RegExpExecArray | null;
    while ((m = sumRe.exec(text)) !== null) sums.set(m[1], Number(m[2]));
    while ((m = countRe.exec(text)) !== null) counts.set(m[1], Number(m[2]));
    while ((m = bucketRe.exec(text)) !== null) {
      const pid = m[1];
      if (!buckets.has(pid)) buckets.set(pid, []);
      if (m[2] !== "+Inf") {
        buckets.get(pid)!.push({ le: Number(m[2]), count: Number(m[3]) });
      }
    }

    for (const [proxyId, sum] of sums) {
      const count = counts.get(proxyId) ?? 0;
      const b = buckets.get(proxyId) ?? [];
      b.sort((a, c) => a.le - c.le);

      rows.push({
        proxyId,
        kind: label,
        count,
        sum,
        p50: percentileFromBuckets(b, count, 0.5),
        p99: percentileFromBuckets(b, count, 0.99),
      });
    }
  }

  return rows;
}

function percentileFromBuckets(
  buckets: { le: number; count: number }[],
  total: number,
  pct: number,
): number | null {
  if (total === 0 || buckets.length === 0) return null;
  const target = total * pct;
  for (const b of buckets) {
    if (b.count >= target) return b.le;
  }
  return buckets[buckets.length - 1]?.le ?? null;
}

function parseRateLimitTotal(text: string): number | null {
  const m = /^ferrum_rate_limit_exceeded_total(?:\{[^}]*\})?\s+(\d+)/m.exec(
    text,
  );
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function statusCodeVariant(
  code: string,
): "green" | "yellow" | "red" | "blue" {
  if (code.startsWith("2")) return "green";
  if (code.startsWith("3")) return "blue";
  if (code.startsWith("4")) return "yellow";
  if (code.startsWith("5")) return "red";
  return "blue";
}

function fmtMs(v: number | null): string {
  if (v === null) return "--";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`;
}

/* ------------------------------------------------------------------ */
/*  Aggregation helpers                                                */
/* ------------------------------------------------------------------ */

interface ProxySummary {
  proxyId: string;
  totalRequests: number;
  byStatus: { code: string; count: number }[];
  avgLatencyMs: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
}

function aggregateProxySummaries(
  requests: ProxyRequestRow[],
  latencies: ProxyLatency[],
): ProxySummary[] {
  const byProxy = new Map<string, ProxyRequestRow[]>();
  for (const r of requests) {
    if (!byProxy.has(r.proxyId)) byProxy.set(r.proxyId, []);
    byProxy.get(r.proxyId)!.push(r);
  }

  const latencyByProxy = new Map<string, ProxyLatency>();
  for (const l of latencies) {
    if (l.kind === "request") latencyByProxy.set(l.proxyId, l);
  }

  const summaries: ProxySummary[] = [];
  for (const [proxyId, rows] of byProxy) {
    const totalRequests = rows.reduce((s, r) => s + r.count, 0);
    const statusMap = new Map<string, number>();
    for (const r of rows) {
      statusMap.set(r.statusCode, (statusMap.get(r.statusCode) ?? 0) + r.count);
    }
    const byStatus = Array.from(statusMap.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const lat = latencyByProxy.get(proxyId);

    summaries.push({
      proxyId,
      totalRequests,
      byStatus,
      avgLatencyMs: lat && lat.count > 0 ? lat.sum / lat.count : null,
      p50Ms: lat?.p50 ?? null,
      p99Ms: lat?.p99 ?? null,
    });
  }

  return summaries.sort((a, b) => b.totalRequests - a.totalRequests);
}

/* ================================================================== */
/*  PrometheusStatsPanel                                               */
/* ================================================================== */

export function PrometheusStatsPanel({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);

  const requests = useMemo(() => parseRequestRows(text), [text]);
  const latencies = useMemo(() => parseLatencyRows(text), [text]);
  const rateLimitTotal = useMemo(() => parseRateLimitTotal(text), [text]);
  const summaries = useMemo(
    () => aggregateProxySummaries(requests, latencies),
    [requests, latencies],
  );

  if (summaries.length === 0 && !text.trim()) {
    return (
      <p className="text-text-muted text-sm py-4">
        No Prometheus metrics available. Enable the{" "}
        <code className="text-xs bg-code-bg px-1 py-0.5 rounded">
          prometheus_metrics
        </code>{" "}
        plugin to collect per-route data.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Per-route summary table */}
      {summaries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-text-primary">
              Requests by Route
            </h4>
            {rateLimitTotal !== null && rateLimitTotal > 0 && (
              <Badge variant="yellow">
                {rateLimitTotal.toLocaleString()} rate-limited
              </Badge>
            )}
          </div>
          <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[minmax(0,2fr)_6rem_minmax(0,2fr)_5rem_5rem_5rem] gap-4 px-5 py-2.5 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
              <span>Proxy</span>
              <span className="text-right">Requests</span>
              <span>Status Codes</span>
              <span className="text-right">Avg</span>
              <span className="text-right">p50</span>
              <span className="text-right">p99</span>
            </div>
            {/* Rows */}
            <div className="divide-y divide-border/50">
              {summaries.map((s) => (
                <div
                  key={s.proxyId}
                  className="grid grid-cols-[minmax(0,2fr)_6rem_minmax(0,2fr)_5rem_5rem_5rem] gap-4 px-5 py-3 text-sm"
                >
                  <span
                    className="text-text-primary font-mono truncate"
                    title={s.proxyId}
                  >
                    {s.proxyId}
                  </span>
                  <span className="text-text-secondary text-right tabular-nums font-medium">
                    {s.totalRequests.toLocaleString()}
                  </span>
                  <div className="flex flex-wrap items-center gap-1 min-w-0">
                    {s.byStatus.map((st) => (
                      <Badge key={st.code} variant={statusCodeVariant(st.code)}>
                        {st.code}: {st.count.toLocaleString()}
                      </Badge>
                    ))}
                  </div>
                  <span className="text-text-muted text-right tabular-nums">
                    {fmtMs(s.avgLatencyMs)}
                  </span>
                  <span className="text-text-muted text-right tabular-nums">
                    {fmtMs(s.p50Ms)}
                  </span>
                  <span className="text-text-muted text-right tabular-nums">
                    {fmtMs(s.p99Ms)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Raw text toggle */}
      <div>
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer flex items-center gap-1"
          onClick={() => setShowRaw(!showRaw)}
        >
          <svg
            className={`w-3 h-3 transition-transform ${showRaw ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 5l7 7-7 7"
            />
          </svg>
          {showRaw ? "Hide" : "Show"} raw Prometheus text
        </button>
        {showRaw && (
          <div className="mt-2 bg-bg-card border border-border rounded-xl overflow-auto max-h-[400px]">
            <pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre">
              <code>{text}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
