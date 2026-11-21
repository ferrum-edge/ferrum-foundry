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
import { PageHeader } from "@/components/shared/PageHeader";
import { ReadStateNotice } from "@/components/shared/ReadState";
import { formatDateTime } from "@/lib/format";
import type { DatabaseMtlsDnsAdmissionFence } from "@/api/types";
import { isNamespaceName } from "../../../shared/namespace.js";

/**
 * A health field rendered as text. Edge sends strings and numbers here; any
 * other shape (a malformed snapshot) reads as `fallback` instead of reaching
 * React as an object child, so one bad field never hides the rest of Status.
 */
function displayScalar(value: unknown, fallback = "Not reported"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

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
      <span className="text-text-primary text-sm font-medium text-right break-words">
        {children}
      </span>
    </div>
  );
}

const FENCE_RUNBOOK = 'https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/mongodb.md#retained-mtls-dns-admission-fences';
/** The largest epoch-millisecond value a JavaScript `Date` represents. */
const MAX_DATE_MS = 8.64e15;

/**
 * A retained MongoDB mTLS DNS admission fence, rendered only for a literal
 * `fenced: true` (as `healthFindings()` reports it). The fence itself changes
 * neither `status`, `ready` nor `database.status`, so a fenced snapshot can
 * still report healthy values there and this is the only place the
 * fail-closed admissions show. Each detail is shown only when it has the
 * shape Edge documents (a count of at least 1, epoch milliseconds, a list of
 * valid namespace names); anything else reads "Not reported" and never
 * reaches React as an object.
 */
function MtlsDnsAdmissionFence({ fence }: { fence: DatabaseMtlsDnsAdmissionFence }) {
  const count: unknown = fence.retained_fences;
  const since: unknown = fence.oldest_retained_since_unix_ms;
  const names: unknown = fence.namespaces;
  const retained = Number.isSafeInteger(count) && (count as number) >= 1 ? count as number : undefined;
  const oldest = Number.isSafeInteger(since) && (since as number) >= 0 && (since as number) <= MAX_DATE_MS
    ? formatDateTime(since as number) : undefined;
  // A list with any entry that is not a valid namespace name is not reported
  // at all, and the
  // copy then names no namespace as unaffected.
  const namespaces = Array.isArray(names) && names.length > 0 && names.every(isNamespaceName)
    ? names as string[] : null;
  return (
    <div role="region" aria-label="mTLS DNS admission fence" className="border-t border-border pt-3 space-y-2">
      <h3 className="text-sm font-medium text-warning">mTLS DNS admission fence</h3>
      <p className="text-warning text-sm">
        This gateway process retains an mTLS DNS admission fence.{' '}
        {namespaces
          ? 'mTLS DNS admissions for the namespaces below fail closed with HTTP 503 here; other namespaces are unaffected.'
          : 'mTLS DNS admissions for the affected namespaces fail closed with HTTP 503 here.'}
        {' '}Reconnect and failover are unaffected, and other replicas report their own fences.
      </p>
      <p className="text-sm text-text-secondary">
        Normally a fence clears in this process when a later admission for the namespace verifies, on the original
        database topology, that its admission lock is gone. To clear it, verify the write's outcome and remove the
        exact owner-qualified admission lock from the database; the next admission then confirms it is gone. When
        that verification is unavailable (the original topology is gone, or the deployment rejects majority read
        concern), reconcile the write, remove any remaining lock, and restart the process. See{' '}
        <a className="underline" href={FENCE_RUNBOOK} target="_blank" rel="noreferrer">
          Ferrum Edge&apos;s retained mTLS DNS admission fence runbook
        </a>.
      </p>
      <HealthFields fields={[
        ['Retained fences', retained],
        ['Oldest retained since', oldest],
        ['Namespaces', namespaces ? namespaces.join(', ') : undefined],
      ]} />
    </div>
  );
}

/* ================================================================== */
/*  StatusPage                                                         */
/* ================================================================== */

const REFRESH_MS = 30_000;

/** One column, then two on wide screens; cards size to their own content. */
const GRID = "grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start";
/** A notice that qualifies every card below it spans the whole grid. */
const WIDE = "xl:col-span-2";

export default function StatusPage() {
  // The page warns when `isStale`. A snapshot only becomes stale after two
  // missed refreshes: with staleTime equal to the interval it went stale on
  // every cycle while the next read was in flight, flashing "Current state is
  // unknown" over a healthy gateway whenever that read ran a little slower.
  const query = useHealth(REFRESH_MS, 2 * REFRESH_MS);
  const { data: health, isLoading, isError } = query;

  const header = (
    <PageHeader
      title="Health Status"
      description="Foundry's connection to the gateway and the gateway's own process, storage, and pipeline diagnostics. Refreshes every 30 seconds."
    />
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <div className={GRID}>
          <BffConnectionCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  // A failed read shows no verdict, not even the last one. The shared notice
  // says whether the read was denied or is unavailable, or, with a snapshot
  // held, that it could not refresh and when it was last observed (#680).
  if (isError) {
    return (
      <div className="space-y-6">
        {header}
        <div className={GRID}>
          <BffConnectionCard />
          <ReadStateNotice query={query} label="Health status" />
        </div>
      </div>
    );
  }

  if (!health) return (
    <div className="space-y-6">
      {header}
      <div className={GRID}>
        <BffConnectionCard />
      </div>
    </div>
  );

  const findings = healthFindings(health);

  return (
    <div className="space-y-6">
      {header}

      {/* Cards keep their reading order and flow two across on wide
          screens; notices that qualify everything below span both. */}
      <div className={GRID}>
        <BffConnectionCard />

        {/* Gateway process details are separate from Foundry connectivity. */}
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">Gateway process health</h2>
          <div className="flex flex-wrap items-center gap-3">
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
          </div>
          {(health.mode || health.timestamp) && (
            <div className="mt-3 space-y-2">
              {health.mode && <Row label="Mode">{health.mode}</Row>}
              {health.timestamp && <Row label="Reported at">{formatDateTime(health.timestamp)}</Row>}
            </div>
          )}
        </Card>

        {query.isStale && <Card role="status" className={`${WIDE} border-warning/40`}>
          <p className="text-warning text-sm">Health snapshot is stale. Current state is unknown; values below are the last observation.</p>
        </Card>}
        {!isDetailedHealth(health) && <p className={`${WIDE} text-sm text-text-muted`}>Only a minimal health snapshot was returned. Omitted diagnostics and audit collection are unknown.</p>}
        {findings.length > 0 && <Card role="status" className={`${WIDE} border-warning/40`}>
          <h2 className="text-warning font-semibold">Operational diagnostics need attention</h2>
          <ul className="list-disc pl-5 mt-2 text-sm text-text-secondary">
            {findings.map(finding => <li key={finding}>{finding}</li>)}
          </ul>
        </Card>}

        {/* Database */}
        {health.database && (
          <Card>
            <h2 className="text-sm font-semibold text-text-primary mb-3">Database</h2>
            <div className="space-y-2">
              <Row label="Status">
                <Badge
                  variant={health.database.status === "connected" ? "green" : "red"}
                >
                  {displayScalar(health.database.status)}
                </Badge>
              </Row>
              {health.database.type && <Row label="Type">{displayScalar(health.database.type)}</Row>}
              {health.database.pool && (
                <Row label="Pool">
                  {displayScalar(health.database.pool.active, "unknown")} active /{" "}
                  {displayScalar(health.database.pool.idle, "unknown")} idle /{" "}
                  {displayScalar(health.database.pool.size, "unknown")} total
                </Row>
              )}
              {health.database.failover_topology && <HealthFields fields={namedFields(health.database.failover_topology, ['primary_active', 'allow_writes', 'opt_in_writes_enabled_during_window', 'primary_failback_fenced', 'active_url_redacted', 'failover_since_unix_ms'])} />}
              {health.database.mtls_dns_admission_fence?.fenced === true && <MtlsDnsAdmissionFence fence={health.database.mtls_dns_admission_fence} />}
              {health.database.pool?.read_replica && <HealthFields fields={[
                ['Read replica active', health.database.pool.read_replica.active],
                ['Read replica idle', health.database.pool.read_replica.idle],
                ['Read replica size', health.database.pool.read_replica.size],
              ]} />}
              {health.database.error && (
                <div className="mt-2 bg-danger/5 border border-danger/20 rounded-lg p-3">
                  <p className="text-danger text-sm">{displayScalar(health.database.error)}</p>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* FIPS */}
        {health.fips && (
          <Card>
            <h2 className="text-sm font-semibold text-text-primary mb-3">
              FIPS compliance
            </h2>
            <div className="space-y-2">
              <Row label="Mode">
                <Badge variant={health.fips.enforcing ? "green" : "default"}>
                  {health.fips.mode}
                </Badge>
              </Row>
              <Row label="Provider">{health.fips.provider}</Row>
              <Row label="Build profile">{health.fips.build_profile}</Row>
              <Row label="Self-test passed">
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
              Cached configuration
            </h2>
            <div className="space-y-2">
              <Row label="Available">
                <Badge variant={health.cached_config.available ? "green" : "red"}>
                  {health.cached_config.available ? "Yes" : "No"}
                </Badge>
              </Row>
              {health.cached_config.loaded_at && (
                <Row label="Loaded at">
                  {formatDateTime(health.cached_config.loaded_at)}
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
    </div>
  );
}
