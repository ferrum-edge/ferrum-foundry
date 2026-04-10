/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Dashboard landing page                            */
/* ------------------------------------------------------------------ */

import { Link } from "@tanstack/react-router";
import { useHealth, useAdminMetrics } from "@/hooks/useMetrics";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/metrics/StatCard";
import { SkeletonCard } from "@/components/ui/Skeleton";

/* ── Helpers ───────────────────────────────────────────────────────── */

const REFRESH_KEY = "ferrum:metricsRefreshInterval";
const DEFAULT_REFRESH = 300_000;

function getRefreshInterval(): number {
  try {
    const stored = localStorage.getItem(REFRESH_KEY);
    return stored ? Number(stored) : DEFAULT_REFRESH;
  } catch {
    return DEFAULT_REFRESH;
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ── Navigation cards config ──────────────────────────────────────── */

const NAV_CARDS = [
  {
    title: "Manage Proxies",
    description: "Configure API routes, backends, and load balancing rules",
    href: "/proxies",
    icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1",
  },
  {
    title: "Manage Consumers",
    description: "Add and manage API consumers and their credentials",
    href: "/consumers",
    icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  },
  {
    title: "Manage Plugins",
    description: "Enable authentication, rate limiting, and transformations",
    href: "/plugins",
    icon: "M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z",
  },
  {
    title: "Manage Upstreams",
    description: "Define target groups, health checks, and balancing algorithms",
    href: "/upstreams",
    icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2",
  },
];

/* ================================================================== */
/*  DashboardPage                                                      */
/* ================================================================== */

export default function DashboardPage() {
  const refreshInterval = getRefreshInterval();
  const health = useHealth();
  const metrics = useAdminMetrics(refreshInterval);

  const isConnected = !health.isError && !metrics.isError;

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-8">
      {/* ── Welcome header ─────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-orange/15 border border-orange/20">
          <svg
            className="w-7 h-7 text-orange"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.047 8.287 8.287 0 009 9.601a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18a3.75 3.75 0 00.495-7.468 5.99 5.99 0 00-1.925 3.547 5.975 5.975 0 01-2.133-1.001A3.75 3.75 0 0012 18z"
            />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            Ferrum Foundry
          </h1>
          <p className="text-text-secondary text-sm">
            API gateway management dashboard
          </p>
        </div>
      </div>

      {/* ── Connection error prompt ────────────────────────────────── */}
      {!isConnected && (
        <Card className="border-warning/30 bg-warning/5">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-warning mt-0.5 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <div className="flex-1">
              <p className="text-text-primary font-medium text-sm">
                Unable to connect to the Ferrum gateway
              </p>
              <p className="text-text-secondary text-xs mt-1">
                Check that the Admin API is running and verify your connection
                settings.
              </p>
              <Link to="/settings">
                <Button variant="secondary" size="sm" className="mt-3">
                  Go to Settings
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      )}

      {/* ── Gateway status card ────────────────────────────────────── */}
      {health.isLoading ? (
        <SkeletonCard />
      ) : health.data ? (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            Gateway Status
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <Badge
              variant={health.data.status === "ok" ? "green" : "yellow"}
              className="text-sm px-3 py-1"
            >
              {health.data.status.toUpperCase()}
            </Badge>
            <span className="text-text-secondary text-sm">
              Mode:{" "}
              <span className="text-text-primary font-medium">
                {health.data.mode}
              </span>
            </span>
            <span className="text-text-secondary text-sm">
              Database:{" "}
              <Badge
                variant={
                  health.data.database.status === "ok" ? "green" : "red"
                }
              >
                {health.data.database.status}
              </Badge>
            </span>
          </div>
        </Card>
      ) : null}

      {/* ── Quick stats ────────────────────────────────────────────── */}
      {metrics.isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-card border border-border rounded-lg p-4 space-y-2"
            >
              <div className="h-3 w-16 bg-bg-card-hover rounded animate-pulse" />
              <div className="h-7 w-12 bg-bg-card-hover rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : metrics.data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Proxies"
            value={metrics.data.gateway.proxy_count}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"
                />
              </svg>
            }
          />
          <StatCard
            label="Consumers"
            value={metrics.data.gateway.consumer_count}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
                />
              </svg>
            }
          />
          <StatCard
            label="Upstreams"
            value={metrics.data.gateway.upstream_count}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
                />
              </svg>
            }
          />
          <StatCard
            label="Plugins"
            value={metrics.data.gateway.plugin_config_count}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z"
                />
              </svg>
            }
          />
        </div>
      ) : null}

      {/* ── Additional stats row ───────────────────────────────────── */}
      {metrics.data && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label="Requests / sec"
            value={metrics.data.gateway.requests_per_second_current.toFixed(1)}
            variant="success"
          />
          <StatCard
            label="Uptime"
            value={formatUptime(metrics.data.gateway.uptime_seconds)}
          />
          <StatCard
            label="Ferrum Version"
            value={metrics.data.gateway.ferrum_version}
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
                    key={cb.proxy_id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-text-primary font-mono text-xs">
                      {cb.proxy_id}
                    </span>
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={cb.state === "open" ? "red" : "yellow"}
                      >
                        {cb.state}
                      </Badge>
                      <span className="text-text-muted text-xs">
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
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-text-primary font-mono text-xs">
                    {t.target}
                  </span>
                  <span className="text-text-muted text-xs">
                    since{" "}
                    {new Date(t.since_epoch_ms).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

      {/* ── Quick navigation ───────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Quick Navigation
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {NAV_CARDS.map((card) => (
            <Link key={card.href} to={card.href}>
              <Card hoverable className="h-full">
                <div className="flex items-start gap-3">
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-orange/10 shrink-0">
                    <svg
                      className="w-5 h-5 text-orange"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d={card.icon}
                      />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">
                      {card.title}
                    </h3>
                    <p className="text-text-muted text-xs mt-1">
                      {card.description}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
