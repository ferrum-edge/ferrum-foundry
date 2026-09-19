import type { AuditPipelineStatus } from '@/api/health';
import { auditCollectionState, type HealthObservation } from '@/lib/auditStatus';
import { CounterNote, HealthFields, HealthSection, namedFields } from './HealthSection';

export function AuditPipelineCard({ query }: { query: HealthObservation }) {
  const state = auditCollectionState(query);
  if (state === 'unknown') return <HealthSection title="Admin audit pipeline" status="Unknown" tone="yellow">
    <p className="text-sm text-text-secondary">
      {query.isLoading ? 'Loading health status.' : query.isError ? 'Health read failed; any previous snapshot is stale.' : 'A fresh authenticated detailed health snapshot is required.'}
      {' '}Collection and current delivery availability are unknown.
    </p>
  </HealthSection>;
  if (state === 'disabled') return <HealthSection title="Admin audit pipeline" status="Collection disabled">
    <p className="text-sm text-text-secondary">Ordinary admin mutation collection is disabled. Set <code>FERRUM_ADMIN_AUDIT_ENABLED=true</code> on the gateway to collect new events. Existing records may still be readable.</p>
  </HealthSection>;
  return <PipelineDetails pipeline={query.data!.audit_pipeline!} />;
}

function PipelineDetails({ pipeline: p }: { pipeline: AuditPipelineStatus }) {
  const failed = p.available === false || p.evidence_lost === true;
  const historicalLoss = p.fail_open_unaudited_mutations_total > 0 || p.delivery_failures_total > 0 ||
    p.dropped_durable_handoff_failed_total > 0 || p.dropped_no_durable_spool_total > 0 ||
    p.dropped_retained_capacity_total > 0 || p.corrupt_records_total > 0;
  const warning = p.degraded || p.durability === 'memory' || historicalLoss;
  const tone = failed ? 'red' : warning ? 'yellow' : p.available === true ? 'green' : 'default';
  return <HealthSection title="Admin audit pipeline" tone={tone}
    status={p.evidence_lost ? 'Evidence lost' : p.available === false ? 'Unavailable' : p.degraded ? 'Degraded' : historicalLoss ? 'Recorded failures / audit gaps' : p.available === true ? 'Available' : 'Unknown'}>
    <HealthFields fields={namedFields(p, ['enabled', 'durability', 'policy', 'available', 'degraded', 'evidence_lost', 'last_unavailable_reason', 'degraded_reason'])} />
    {p.policy === 'fail_closed' && p.available === false && <p role="alert" className="text-danger text-sm">
      FERRUM_ADMIN_AUDIT_UNAVAILABLE_POLICY=fail_closed: audited admin mutations are refused with HTTP 503 before they run because durable audit preparation is unavailable.
    </p>}
    {p.policy === 'fail_open' && p.available === false && <p className="text-warning text-sm">
      The fail_open policy allows audited mutations to proceed without durable pre-mutation evidence. Successful writes can have an audit gap.
    </p>}
    {p.degraded && <p className="text-warning text-sm">Degradation is sticky evidence of corrupted, unrecoverable, or discarded records. Recovery of delivery alone does not clear it.</p>}
    {p.evidence_lost && <p className="text-danger text-sm">Audit evidence was permanently discarded. This signal stays set for the process lifetime.</p>}
    <h3 className="font-medium text-sm text-text-primary">Current backlog and limits</h3>
    <HealthFields fields={namedFields(p, ['queue_depth', 'delivery_in_flight', 'spool_prepared_records', 'spool_pending_records', 'spool_retained_records', 'queue_capacity', 'spool_max_records', 'retained_max_records', 'max_delivery_attempts'])} />
    <details>
      <summary className="cursor-pointer text-sm text-text-secondary">Delivery and loss counters</summary>
      <div className="mt-3 space-y-3">
        <CounterNote />
        <HealthFields fields={namedFields(p, ['accepted_total', 'prepared_total', 'finalized_total', 'unknown_outcome_total', 'enqueued_total', 'delivered_total', 'retries_total', 'delivery_failures_total', 'retained_total', 'replayed_total', 'corrupt_records_total', 'destination_mismatch_total', 'truncated_diffs_total', 'dropped_durable_handoff_failed_total', 'dropped_no_durable_spool_total', 'dropped_retained_capacity_total', 'fail_open_unaudited_mutations_total', 'fail_closed_rejections_total'])} />
      </div>
    </details>
  </HealthSection>;
}
