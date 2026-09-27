/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Dashboard landing page                            */
/* ------------------------------------------------------------------ */

import { useState } from 'react';
import { ReadState } from '@/components/shared/ReadState';
import { RefreshControl } from '@/components/metrics/RefreshControl';
import { Link } from "@tanstack/react-router";
import { useHealth, useAdminMetrics } from "@/hooks/useMetrics";
import { useGatewayRequestStats } from "@/hooks/useGatewayRequestStats";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { BffConnectionCard } from "@/components/shared/BffConnectionCard";
import { StatCard } from "@/components/metrics/StatCard";
import { CircuitStateBadge } from "@/components/metrics/CircuitBreakerPanel";
import { PageHeader } from "@/components/shared/PageHeader";
import { NavIcon, type NavIconName } from "@/components/ui/icons";
import { formatDateTime } from "@/lib/format";
import { useNamespace } from "@/stores/namespace";
import {
  getStoredMetricsRefreshInterval,
  setStoredMetricsRefreshInterval,
} from '@/utils/metricsRefresh';

/* ── Helpers ───────────────────────────────────────────────────────── */

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ── Navigation cards config ──────────────────────────────────────── */

const NAV_CARDS: { title: string; description: string; href: string; icon: NavIconName }[] = [
  {
    title: "Manage Proxies",
    description: "Configure API routes, backends, and load balancing rules",
    href: "/proxies",
    icon: "proxies",
  },
  {
    title: "Manage Consumers",
    description: "Add and manage API consumers and their credentials",
    href: "/consumers",
    icon: "consumers",
  },
  {
    title: "Manage Plugins",
    description: "Enable authentication, rate limiting, and transformations",
    href: "/plugins",
    icon: "plugins",
  },
  {
    title: "Manage Upstreams",
    description: "Define target groups, health checks, and balancing algorithms",
    href: "/upstreams",
    icon: "upstreams",
  },
];

function formatRate(rate?: number): string {
  if (rate === undefined) return "Collecting";
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
}

/* ================================================================== */
/*  DashboardPage                                                      */
/* ================================================================== */

export default function DashboardPage() {
  const [refreshInterval, setRefreshInterval] = useState(getStoredMetricsRefreshInterval);
  const { selectedNamespace } = useNamespace();
  const health = useHealth();
  const metrics = useAdminMetrics(refreshInterval);
  const requestStats = useGatewayRequestStats(
    metrics.data?.gateway,
    metrics.dataUpdatedAt,
  );

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          <>
            Gateway status and configuration overview for namespace{" "}
            <span className="font-mono text-text-secondary">{selectedNamespace}</span>.
          </>
        }
        actions={
          <RefreshControl
            refreshInterval={refreshInterval}
            onIntervalChange={(interval) => {
              setRefreshInterval(interval);
              setStoredMetricsRefreshInterval(interval);
            }}
            onRefreshNow={async () => {
              await Promise.all([health.refetch(), metrics.refetch()]);
            }}
            isRefreshing={health.isFetching || metrics.isFetching}
            lastUpdated={metrics.dataUpdatedAt ? new Date(metrics.dataUpdatedAt).toISOString() : undefined}
            lastUpdatedLabel="Admin metrics last updated"
          />
        }
      />

      {/* ── Foundry connection + gateway process health ───────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BffConnectionCard className="h-full" />
        <ReadState queries={[health]} label="Gateway process health">
          {health.data ? (
            <Card className="h-full">
              <h2 className="text-sm font-semibold text-text-primary mb-3">
                Gateway process health
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Badge variant={health.data.status === "ok" ? "green" : "yellow"}>
                  {health.data.status.toUpperCase()}
                </Badge>
                <span className="text-text-secondary text-sm">
                  Mode:{" "}
                  <span className="text-text-primary font-medium">
                    {health.data.mode}
                  </span>
                </span>
                {health.data.database && (
                  <span className="flex items-center gap-1.5 text-text-secondary text-sm">
                    Database:
                    <Badge
                      variant={
                        health.data.database.status === "connected" ? "green" : "red"
                      }
                    >
                      {health.data.database.status}
                    </Badge>
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-3">
                Last successful observation: {formatDateTime(health.dataUpdatedAt)}
              </p>
            </Card>
          ) : null}
        </ReadState>
      </div>

      <ReadState queries={[metrics]} label="Admin metrics">
        {/* ── Resource counts ────────────────────────────────────────── */}
        {metrics.data ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Proxies"
              value={metrics.data.gateway.proxy_count}
              icon={<NavIcon name="proxies" className="w-4 h-4" />}
            />
            <StatCard
              label="Consumers"
              value={metrics.data.gateway.consumer_count}
              icon={<NavIcon name="consumers" className="w-4 h-4" />}
            />
            <StatCard
              label="Upstreams"
              value={metrics.data.gateway.upstream_count}
              icon={<NavIcon name="upstreams" className="w-4 h-4" />}
            />
            <StatCard
              label="Plugins"
              value={metrics.data.gateway.plugin_config_count}
              icon={<NavIcon name="plugins" className="w-4 h-4" />}
            />
          </div>
        ) : null}

        {/* ── Traffic and process ────────────────────────────────────── */}
        {metrics.data && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              label="Requests / sec"
              value={formatRate(requestStats.requestsPerSecond)}
              subtitle={`${requestStats.totalRequests.toLocaleString()} total`}
            />
            <StatCard
              label="Uptime"
              value={formatUptime(metrics.data.gateway.uptime_seconds)}
            />
            <StatCard
              label="Ferrum Version"
              value={metrics.data.gateway.ferrum_version}
              className="col-span-2 lg:col-span-1"
            />
          </div>
        )}

        {/* ── Circuit breaker alerts ─────────────────────────────────── */}
        {metrics.data &&
          metrics.data.circuit_breakers.some((cb) => cb.state !== "closed") && (
            <Card className="border-warning/30">
              <h2 className="text-sm font-semibold text-warning mb-3">
                Circuit Breaker Alerts
              </h2>
              <div className="space-y-2">
                {metrics.data.circuit_breakers
                  .filter((cb) => cb.state !== "closed")
                  .map((cb) => (
                    <div
                      key={`${cb.namespace}:${cb.proxy_id}:${cb.target ?? ""}`}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
                    >
                      <span className="min-w-0 break-all text-text-primary font-mono text-xs">
                        {cb.proxy_id}
                        {cb.target && <span className="text-text-muted"> → {cb.target}</span>}
                      </span>
                      <div className="flex items-center gap-3">
                        <CircuitStateBadge state={cb.state} />
                        <span className="text-text-muted text-xs tabular-nums">
                          {cb.failure_count} failures
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          )}

        {/* ── Unhealthy targets ──────────────────────────────────────── */}
        {metrics.data &&
          metrics.data.health_check.unhealthy_targets.length > 0 && (
            <Card className="border-danger/30">
              <h2 className="text-sm font-semibold text-danger mb-3">
                Unhealthy Targets
              </h2>
              <div className="space-y-2">
                {metrics.data.health_check.unhealthy_targets.map((t) => (
                  <div
                    key={t.target}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
                  >
                    <span className="min-w-0 break-all text-text-primary font-mono text-xs">
                      {t.target}
                    </span>
                    <span className="text-text-muted text-xs">
                      since {formatDateTime(t.since_epoch_ms)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
      </ReadState>

      {/* ── Quick navigation ───────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Quick Navigation
        </h2>
        {/* 2-up until xl so card descriptions don't wrap word-per-line */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {NAV_CARDS.map((card) => (
            <Link key={card.href} to={card.href} className="rounded-xl">
              <Card hoverable className="h-full">
                <div className="flex items-start gap-3">
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-orange/10 text-orange shrink-0">
                    <NavIcon name={card.icon} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">
                      {card.title}
                    </h3>
                    <p className="text-text-secondary text-xs mt-1">
                      {card.description}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
