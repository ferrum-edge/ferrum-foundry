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
