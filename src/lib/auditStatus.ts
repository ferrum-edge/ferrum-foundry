import type { HealthResponse } from '@/api/types';
import type { ReadQuery } from './readState';

export type HealthObservation = Pick<ReadQuery, 'isError' | 'isLoading'> & {
  data?: HealthResponse;
  isStale?: boolean;
  isFetching?: boolean;
};

/** These fields are always emitted together by the authenticated detailed tier.
 * Neither a valid coarse 503 nor an old successful read proves collection off.
 */
export function isDetailedHealth(health: HealthResponse): boolean {
  return typeof health.mode === 'string' && typeof health.timestamp === 'string' &&
    typeof health.admin_writes_enabled === 'boolean' &&
    typeof health.cached_config?.available === 'boolean';
}

export function auditCollectionState(query: HealthObservation): 'unknown' | 'disabled' | 'enabled' {
  if (query.isError || query.isLoading || query.isStale || query.isFetching || !query.data) return 'unknown';
  const pipeline = query.data.audit_pipeline;
  if (pipeline?.enabled === true) return 'enabled';
  if (pipeline?.enabled === false) return 'disabled';
  // A malformed/null section is not absence. Only the detailed tier's omission proves off.
  if (!('audit_pipeline' in query.data) && isDetailedHealth(query.data)) return 'disabled';
  return 'unknown';
}

export function auditEmptyDescription(query: HealthObservation): string {
  const state = auditCollectionState(query);
  if (state === 'disabled') return 'Ordinary admin mutation collection is disabled on this gateway. Enable FERRUM_ADMIN_AUDIT_ENABLED to collect new events; an empty log does not prove no mutations occurred.';
  if (state === 'unknown') return 'No events were returned for this namespace and filter. Audit collection status is unknown until a fresh authenticated detailed health snapshot is available.';
  const p = query.data?.audit_pipeline;
  if (p?.available === false || p?.degraded || p?.evidence_lost) return 'No events were returned for this namespace and filter. The audit pipeline reports unavailable delivery or compromised evidence; this is not proof that no mutations occurred. Review the pipeline status above.';
  return 'Collection is enabled. No recorded events match this namespace, filter, and page. Delivery can lag behind mutations; this does not prove that no mutations occurred.';
}
