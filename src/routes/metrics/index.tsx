/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Metrics dashboard page                            */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { useAdminMetrics, usePrometheusMetrics } from "@/hooks/useMetrics";
import { Card } from "@/components/ui/Card";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { RefreshControl } from "@/components/metrics/RefreshControl";
import { GatewayStats } from "@/components/metrics/GatewayStats";
import { CircuitBreakerPanel } from "@/components/metrics/CircuitBreakerPanel";
import { ConnectionPoolPanel } from "@/components/metrics/ConnectionPoolPanel";
import { HealthCheckPanel } from "@/components/metrics/HealthCheckPanel";
import { LoadBalancerPanel } from "@/components/metrics/LoadBalancerPanel";
import { CachePanel } from "@/components/metrics/CachePanel";
import { RateLimitPanel } from "@/components/metrics/RateLimitPanel";

/* ================================================================== */
/*  MetricsPage                                                        */
/* ================================================================== */

export default function MetricsPage() {
  const [refreshInterval, setRefreshInterval] = useState(300_000);
  const {
    data: metrics,
    isLoading,
    isError,
    error,
    dataUpdatedAt,
    refetch,
  } = useAdminMetrics(refreshInterval || undefined);

  const { data: prometheusText } = usePrometheusMetrics();

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

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toISOString()
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
          onIntervalChange={setRefreshInterval}
          onRefreshNow={() => refetch()}
          lastUpdated={lastUpdated}
        />
      </div>

      {/* Gateway Stats */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3">
          Gateway
        </h2>
        <GatewayStats metrics={metrics.gateway} />
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
      </div>

      {/* Prometheus tab */}
      <Tabs defaultValue="prometheus">
        <TabsList>
          <TabsTrigger value="prometheus">Prometheus</TabsTrigger>
        </TabsList>
        <TabsContent value="prometheus">
          <div className="bg-bg-card border border-border rounded-xl overflow-auto max-h-[600px]">
            <pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre">
              <code>{prometheusText ?? "Loading..."}</code>
            </pre>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
