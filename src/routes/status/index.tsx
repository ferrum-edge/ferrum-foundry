/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health / Status page                              */
/* ------------------------------------------------------------------ */

import { useHealth } from "@/hooks/useMetrics";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";

/* ================================================================== */
/*  StatusPage                                                         */
/* ================================================================== */

export default function StatusPage() {
  const { data: health, isLoading, isError, error } = useHealth();

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Error state                                                      */
  /* ---------------------------------------------------------------- */

  if (isError) {
    return (
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
        <Card>
          <p className="text-danger font-medium">Failed to fetch health status</p>
          <p className="text-text-muted text-sm mt-1">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </Card>
      </div>
    );
  }

  if (!health) return null;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>

      {/* Overall status */}
      <Card>
        <div className="flex items-center gap-4">
          <Badge
            variant={health.status === "ok" ? "green" : "yellow"}
            className="text-base px-4 py-1.5"
          >
            {health.status.toUpperCase()}
          </Badge>
          <div>
            <p className="text-text-secondary text-sm">
              Mode: <span className="text-text-primary font-medium">{health.mode}</span>
            </p>
            <p className="text-text-muted text-xs mt-0.5">
              {new Date(health.timestamp).toLocaleString()}
            </p>
          </div>
        </div>
      </Card>

      {/* Database */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-3">
          Database
        </h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-sm">Status</span>
            <Badge variant={health.database.status === "ok" ? "green" : "red"}>
              {health.database.status}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-sm">Type</span>
            <span className="text-text-primary text-sm font-medium">
              {health.database.type}
            </span>
          </div>
          {health.database.error && (
            <div className="mt-2 bg-danger/5 border border-danger/20 rounded-lg p-3">
              <p className="text-danger text-sm">{health.database.error}</p>
            </div>
          )}
        </div>
      </Card>

      {/* Cached Config */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-3">
          Cached Configuration
        </h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-sm">Available</span>
            <Badge variant={health.cached_config.available ? "green" : "red"}>
              {health.cached_config.available ? "Yes" : "No"}
            </Badge>
          </div>
          {health.cached_config.loaded_at && (
            <div className="flex items-center justify-between">
              <span className="text-text-secondary text-sm">Loaded At</span>
              <span className="text-text-primary text-sm font-medium">
                {new Date(health.cached_config.loaded_at).toLocaleString()}
              </span>
            </div>
          )}
          {health.cached_config.proxy_count != null && (
            <div className="flex items-center justify-between">
              <span className="text-text-secondary text-sm">Proxies</span>
              <span className="text-text-primary text-sm font-medium">
                {health.cached_config.proxy_count}
              </span>
            </div>
          )}
          {health.cached_config.consumer_count != null && (
            <div className="flex items-center justify-between">
              <span className="text-text-secondary text-sm">Consumers</span>
              <span className="text-text-primary text-sm font-medium">
                {health.cached_config.consumer_count}
              </span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
