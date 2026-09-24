/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Health / Status page                              */
/* ------------------------------------------------------------------ */

import { AuditPipelineCard } from '@/components/health/AuditPipelineCard';
import { OperationalHealthCards, healthFindings } from '@/components/health/OperationalHealthCards';
import { HealthFields, namedFields } from '@/components/health/HealthSection';
import { isDetailedHealth } from '@/lib/auditStatus';
import { useHealth } from "@/hooks/useMetrics";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { BffConnectionCard } from "@/components/shared/BffConnectionCard";

function statusVariant(
  status: string,
): "green" | "yellow" | "red" {
  if (status === "ok") return "green";
  if (status === 'degraded' || status === 'starting' || status === 'draining') return 'yellow';
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

const REFRESH_MS = 30_000;

export default function StatusPage() {
  // The page warns when `isStale`. A snapshot only becomes stale after two
  // missed refreshes: with staleTime equal to the interval it went stale on
  // every cycle while the next read was in flight, flashing "Current state is
  // unknown" over a healthy gateway whenever that read ran a little slower.
  const query = useHealth(REFRESH_MS, 2 * REFRESH_MS);
  const { data: health, isLoading, isError, error } = query;

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

  const findings = healthFindings(health);

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-text-primary">Health Status</h1>
      <BffConnectionCard />

      {query.isStale && <Card role="status" className="border-warning/40">
        <p className="text-warning text-sm">Health snapshot is stale. Current state is unknown; values below are the last observation.</p>
      </Card>}
      {!isDetailedHealth(health) && <p className="text-sm text-text-muted">Only a minimal health snapshot was returned. Omitted diagnostics and audit collection are unknown.</p>}
      {findings.length > 0 && <Card role="status" className="border-warning/40">
        <h2 className="text-warning font-semibold">Operational diagnostics need attention</h2>
        <ul className="list-disc pl-5 mt-2 text-sm text-text-secondary">
          {findings.map(finding => <li key={finding}>{finding}</li>)}
        </ul>
      </Card>}

      {/* Gateway process details are separate from Foundry connectivity. */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Gateway process health</h2>
        <div className="flex flex-wrap items-center gap-4">
          <Badge
            variant={query.isStale ? "default" : health.status === "ok" && findings.length > 0 ? "yellow" : statusVariant(health.status)}
            className="text-base px-4 py-1.5"
          >
            {health.status.toUpperCase()}
          </Badge>
          <Badge variant={query.isStale ? "default" : health.ready ? "green" : "red"}>
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
                {health.database.pool.active ?? "unknown"} active /{" "}
                {health.database.pool.idle ?? "unknown"} idle /{" "}
                {health.database.pool.size ?? "unknown"} total
              </Row>
            )}
            {health.database.failover_topology && <HealthFields fields={namedFields(health.database.failover_topology, ['primary_active', 'allow_writes', 'opt_in_writes_enabled_during_window', 'primary_failback_fenced', 'active_url_redacted', 'failover_since_unix_ms'])} />}
            {health.database.pool?.read_replica && <HealthFields fields={[
              ['Read replica active', health.database.pool.read_replica.active],
              ['Read replica idle', health.database.pool.read_replica.idle],
              ['Read replica size', health.database.pool.read_replica.size],
            ]} />}
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
              {health.fips.build_capable ? (health.fips.module_self_test_passed ? "Yes" : "No") : "No validated module in this build"}
            </Row>
            <HealthFields fields={namedFields(health.fips, ['build_capable', 'provider_algorithms_approved', 'certified', 'boundary_documentation'])} />
            <p className="text-xs text-text-muted">Enforcement is not certification. Ferrum Edge is not independently FIPS-certified.</p>
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
      <AuditPipelineCard query={query} />
      <OperationalHealthCards health={health} />
    </div>
  );
}
