/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health / Status page                              */
/* ------------------------------------------------------------------ */

import { useHealth } from "@/hooks/useMetrics";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { BffConnectionCard } from "@/components/shared/BffConnectionCard";

function statusVariant(
  status: string,
): "green" | "yellow" | "red" {
  if (status === "ok") return "green";
  if (status === "degraded" || status === "starting") return "yellow";
  return "red";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-text-secondary text-sm">{label}</span>
      <span className="text-text-primary text-sm font-medium text-right">
        {children}
      </span>
    </div>
  );
}

/* ================================================================== */
/*  StatusPage                                                         */
/* ================================================================== */

export default function StatusPage() {
  const { data: health, isLoading, isError, error } = useHealth();

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
        <BffConnectionCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
        <BffConnectionCard />
        <Card>
          <p className="text-danger font-medium">Failed to fetch health status</p>
          <p className="text-text-muted text-sm mt-1">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </Card>
      </div>
    );
  }

  if (!health) return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
      <BffConnectionCard />
    </div>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
      <BffConnectionCard />

      {/* Gateway process details are separate from Foundry connectivity. */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Gateway process health</h2>
        <div className="flex flex-wrap items-center gap-4">
          <Badge
            variant={statusVariant(health.status)}
            className="text-base px-4 py-1.5"
          >
            {health.status.toUpperCase()}
          </Badge>
          <Badge variant={health.ready ? "green" : "red"}>
            {health.ready ? "Ready" : "Not Ready"}
          </Badge>
          {health.admin_writes_enabled === false && (
            <Badge variant="yellow">Read-only admin</Badge>
          )}
          {health.config_rejected && (
            <Badge variant="red">Config rejected</Badge>
          )}
          <div>
            {health.mode && (
              <p className="text-text-secondary text-sm">
                Mode:{" "}
                <span className="text-text-primary font-medium">{health.mode}</span>
              </p>
            )}
            {health.timestamp && (
              <p className="text-text-muted text-xs mt-0.5">
                {new Date(health.timestamp).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Database */}
      {health.database && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">Database</h2>
          <div className="space-y-2">
            <Row label="Status">
              <Badge
                variant={health.database.status === "connected" ? "green" : "red"}
              >
                {health.database.status}
              </Badge>
            </Row>
            {health.database.type && <Row label="Type">{health.database.type}</Row>}
            {health.database.pool && (
              <Row label="Pool">
                {health.database.pool.active ?? 0} active /{" "}
                {health.database.pool.idle ?? 0} idle /{" "}
                {health.database.pool.size ?? 0} total
              </Row>
            )}
            {health.database.error && (
              <div className="mt-2 bg-danger/5 border border-danger/20 rounded-lg p-3">
                <p className="text-danger text-sm">{health.database.error}</p>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* FIPS */}
      {health.fips && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            FIPS Compliance
          </h2>
          <div className="space-y-2">
            <Row label="Mode">
              <Badge variant={health.fips.enforcing ? "green" : "default"}>
                {health.fips.mode}
              </Badge>
            </Row>
            <Row label="Provider">{health.fips.provider}</Row>
            <Row label="Build Profile">{health.fips.build_profile}</Row>
            <Row label="Self-test Passed">
              {health.fips.module_self_test_passed ? "Yes" : "No"}
            </Row>
          </div>
        </Card>
      )}

      {/* Cached Config */}
      {health.cached_config && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            Cached Configuration
          </h2>
          <div className="space-y-2">
            <Row label="Available">
              <Badge variant={health.cached_config.available ? "green" : "red"}>
                {health.cached_config.available ? "Yes" : "No"}
              </Badge>
            </Row>
            {health.cached_config.loaded_at && (
              <Row label="Loaded At">
                {new Date(health.cached_config.loaded_at).toLocaleString()}
              </Row>
            )}
            {health.cached_config.proxy_count != null && (
              <Row label="Proxies">{health.cached_config.proxy_count}</Row>
            )}
            {health.cached_config.consumer_count != null && (
              <Row label="Consumers">{health.cached_config.consumer_count}</Row>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
