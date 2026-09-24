/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – retire a deleted resource's detail query         */
/*                                                                    */
/*  Issue #328: `removeQueries` on a still-observed key recreates the  */
/*  query and refetches. After a successful delete that GET 404s and   */
/*  pops the global API Error modal even though the mutation worked.  */
/*                                                                    */
/*  Cancel in-flight work and drop the exact detail entry *before*    */
/*  list invalidation. The detail observer must already be disabled    */
/*  (route unmounting, or the id known-deleted) so this does not       */
/*  recreate the query. Do not swallow 404s globally.                */
/* ------------------------------------------------------------------ */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getCommittedWrite } from "@/api/client";
import type { CommittedWrite } from "@/api/gatewayMetadata";

/**
 * Cancel any in-flight fetch for `queryKey` and remove that exact cache
 * entry. Callers must disable the matching observer first; otherwise
 * TanStack Query will rebuild the query and refetch the deleted id.
 */
export async function retireDeletedDetail(
  qc: QueryClient,
  queryKey: QueryKey,
): Promise<void> {
  await qc.cancelQueries({ queryKey, exact: true });
  qc.removeQueries({ queryKey, exact: true });
}

/** What a detail-page delete reports once the resource is gone. */
export interface DeleteOutcome {
  /** The namespace the delete was issued under, even after a switch. */
  readonly namespace: string;
  readonly id: string;
  /**
   * Set when the gateway answered the committed-but-not-live `503`: the delete
   * is durable and only the live apply lagged. `null` for an ordinary `2xx`.
   */
  readonly committed: CommittedWrite | null;
}

/**
 * Run a delete, resolving a committed-but-not-live answer as the deletion it
 * is rather than as a failure.
 *
 * A delete has no response body to adopt, so the commit fully describes its
 * outcome: the mutation succeeds, its `onSuccess` retires the seeded detail
 * entry and invalidates the lists exactly as for a `204`, and the page reports
 * "committed, not yet proven live" instead of "failed". Every other rejection —
 * including a guard refusal and an unobserved outcome — propagates unchanged.
 */
export async function removeCommitted(
  remove: () => Promise<void>,
): Promise<CommittedWrite | null> {
  try {
    await remove();
    return null;
  } catch (error) {
    const committed = getCommittedWrite(error);
    if (committed) return committed;
    throw error;
  }
}
