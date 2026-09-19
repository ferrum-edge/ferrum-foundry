import { isHTTPError } from 'ky';
import { extractApiErrorData } from '@/api/client';
import type { MeshRuntimeValue } from '@/api/mesh';
import { useRuntimeOverlay } from '@/hooks/useMesh';
import { ReadState } from '@/components/shared/ReadState';
import { HealthFields, HealthSection } from '@/components/health/HealthSection';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

function RuntimeValue({ entry }: { entry: MeshRuntimeValue }) {
  if (entry.kind === 'fractional_percent') {
    const units = { hundred: 100, ten_thousand: 10_000, million: 1_000_000 }[entry.value.denominator];
    return <>{entry.value.numerator} / {units.toLocaleString()} ({Math.min(100, entry.value.numerator / units * 100)}%)</>;
  }
  return <>{String(entry.value)}</>;
}

export function RuntimeTab() {
  const query = useRuntimeOverlay();
  const status = isHTTPError(query.error) ? query.error.response.status : undefined;
  const noOverlay = status === 404 && isHTTPError(query.error) &&
    extractApiErrorData(query.error.data) === 'No active mesh runtime overlay';
  if (query.isError && (noOverlay || status === 503)) return <HealthSection title="Runtime overlay" tone="yellow"
    status={noOverlay ? 'No active overlay' : 'Temporarily unavailable'}>
    <p className="text-sm text-text-secondary">{noOverlay
      ? 'The connected node is outside mesh mode or has not accepted its first slice. This differs from an accepted slice with no runtime fields.'
      : 'The gateway could not serve runtime state (HTTP 503). Current overlay state is unknown; this does not prove mesh is disabled.'}</p>
    {query.data && <p className="text-sm text-warning">The previous overlay is stale and is not shown as current.</p>}
    <Button variant="secondary" size="sm" onClick={() => void query.refetch()} loading={query.isFetching}>Retry runtime overlay</Button>
  </HealthSection>;
  return <div className="space-y-4">
    {(status === 401 || status === 403) && <p role="alert" className="text-danger text-sm">Access to runtime state was denied (HTTP {status}). This is not evidence that no overlay exists.</p>}
    <ReadState queries={[query]} label="Runtime overlay">
      {query.data && <HealthSection title="Runtime overlay · connected node" status="Accepted slice">
        <p className="text-sm text-text-secondary">Live overlay published with this workload’s last proxy-accepted slice. The gateway does not return a node ID or a fleet-wide node list on this endpoint.</p>
        <HealthFields fields={[["Slice namespace", query.data.namespace], ["Accepted version", query.data.version]]} />
        {Object.keys(query.data.runtime_overlay.fields ?? {}).length === 0 ?
          <p className="text-sm text-text-muted">The accepted slice has no runtime fields.</p> :
          <dl className="divide-y divide-border">
            {Object.entries(query.data.runtime_overlay.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => <div key={key} className="py-3 space-y-2">
              <dt className="text-sm font-mono text-text-primary break-all">{key}</dt>
              <dd className="flex flex-wrap gap-3 items-center text-sm text-text-secondary break-all">
                <Badge variant="default">{entry.kind.replaceAll('_', ' ')}</Badge><span><RuntimeValue entry={entry} /></span>
              </dd>
            </div>)}
          </dl>}
      </HealthSection>}
    </ReadState>
  </div>;
}
