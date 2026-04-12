/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Metrics dashboard page                            */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminMetrics, usePrometheusMetrics } from "@/hooks/useMetrics";
import { useGatewayRequestStats } from "@/hooks/useGatewayRequestStats";
import { Card } from "@/components/ui/Card";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { RefreshControl } from "@/components/metrics/RefreshControl";
import { StatCard } from "@/components/metrics/StatCard";
import { GatewayStats } from "@/components/metrics/GatewayStats";
import { CircuitBreakerPanel } from "@/components/metrics/CircuitBreakerPanel";
import { ConnectionPoolPanel } from "@/components/metrics/ConnectionPoolPanel";
import { HealthCheckPanel } from "@/components/metrics/HealthCheckPanel";
import { LoadBalancerPanel } from "@/components/metrics/LoadBalancerPanel";
import { CachePanel } from "@/components/metrics/CachePanel";
import { RateLimitPanel } from "@/components/metrics/RateLimitPanel";
import { PrometheusStatsPanel } from "@/components/metrics/PrometheusStatsPanel";
import {
  getStoredMetricsLastUpdated,
  getStoredMetricsRefreshInterval,
  setStoredMetricsLastUpdated,
  setStoredMetricsRefreshInterval,
} from "@/utils/metricsRefresh";

/* ================================================================== */
/*  MetricsPage                                                        */
/* ================================================================== */

export default function MetricsPage() {
  const [refreshInterval, setRefreshInterval] = useState(
    getStoredMetricsRefreshInterval,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState(
    getStoredMetricsLastUpdated,
  );
  const hasSeenInitialFetch = useRef(false);
  const lastSyncedDataUpdatedAt = useRef(0);

  const {
    data: metrics,
    isLoading,
    isError,
    error,
    dataUpdatedAt,
    isFetching: isAdminMetricsFetching,
    refetch: refetchAdminMetrics,
  } = useAdminMetrics(refreshInterval);

  const {
    data: prometheusText,
    isFetching: isPrometheusFetching,
    refetch: refetchPrometheusMetrics,
  } = usePrometheusMetrics();

  const requestStats = useGatewayRequestStats(metrics?.gateway, dataUpdatedAt);

  const syncLastUpdated = useCallback((timestamp: number) => {
    setLastUpdatedAt(timestamp);
    try {
      setStoredMetricsLastUpdated(timestamp);
    } catch {
      // Ignore storage failures; the in-page timestamp still updates.
    }
  }, []);

  useEffect(() => {
    if (!dataUpdatedAt || lastSyncedDataUpdatedAt.current === dataUpdatedAt) {
      return;
    }

    lastSyncedDataUpdatedAt.current = dataUpdatedAt;

    if (!hasSeenInitialFetch.current) {
      hasSeenInitialFetch.current = true;
      if (!lastUpdatedAt) {
        syncLastUpdated(dataUpdatedAt);
      }
      return;
    }

    syncLastUpdated(dataUpdatedAt);
  }, [dataUpdatedAt, lastUpdatedAt, syncLastUpdated]);

  const handleIntervalChange = (intervalMs: number) => {
    setRefreshInterval(intervalMs);
    try {
      setStoredMetricsRefreshInterval(intervalMs);
    } catch {
      // Ignore storage failures; the selected interval still applies in-page.
    }
  };

  const handleRefreshNow = async () => {
    const [adminMetricsResult] = await Promise.all([
      refetchAdminMetrics(),
      refetchPrometheusMetrics(),
    ]);

    if (adminMetricsResult.isSuccess && adminMetricsResult.dataUpdatedAt) {
      syncLastUpdated(adminMetricsResult.dataUpdatedAt);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-text-primary">
            Metrics Dashboard
          </h1>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Error state                                                      */
  /* ---------------------------------------------------------------- */

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-text-primary">
          Metrics Dashboard
        </h1>
        <Card>
          <p className="text-danger font-medium">Failed to load metrics</p>
          <p className="text-text-muted text-sm mt-1">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </Card>
      </div>
    );
  }

  if (!metrics) return null;

  const lastUpdated = lastUpdatedAt
    ? new Date(lastUpdatedAt).toISOString()
    : undefined;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">
          Metrics Dashboard
        </h1>
        <RefreshControl
          refreshInterval={refreshInterval}
          onIntervalChange={handleIntervalChange}
          onRefreshNow={handleRefreshNow}
          lastUpdated={lastUpdated}
          isRefreshing={isAdminMetricsFetching || isPrometheusFetching}
        />
      </div>

      {/* Gateway Stats */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3">
          Gateway
        </h2>
        <GatewayStats metrics={metrics.gateway} requestStats={requestStats} />
      </section>

      {/* Panels grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Circuit Breakers
          </h3>
          <CircuitBreakerPanel breakers={metrics.circuit_breakers} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Connection Pools
          </h3>
          <ConnectionPoolPanel pools={metrics.connection_pools} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Health Checks
          </h3>
          <HealthCheckPanel healthCheck={metrics.health_check} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Load Balancers
          </h3>
          <LoadBalancerPanel loadBalancers={metrics.load_balancers} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Caches
          </h3>
          <CachePanel caches={metrics.caches} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Rate Limiting
          </h3>
          <RateLimitPanel rateLimiting={metrics.rate_limiting} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Consumer Index
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Total Consumers" value={metrics.consumer_index.total_consumers} />
            {(Object.entries(metrics.consumer_index) as [string, number][])
              .filter(([key, val]) => key !== "total_consumers" && val > 0)
              .map(([key, val]) => (
                <StatCard
                  key={key}
                  label={key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  value={val}
                />
              ))}
          </div>
        </Card>
      </div>

      {/* Per-route Prometheus stats */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3">
          Per-Route Metrics
        </h2>
        <PrometheusStatsPanel text={prometheusText ?? ""} />
      </section>
    </div>
  );
}
