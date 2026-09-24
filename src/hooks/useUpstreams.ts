/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Upstreams               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { isCommittedWrite, queryScope } from "@/api/client";
import { useMemo } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ALL_PAGE_SIZE } from "@/api/pagination";
import * as upstreams from "@/api/upstreams";
import type { WriteGuard } from "@/api/conditionalWrite";
import type { PaginationParams, Upstream, UpstreamCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import {
  removeCommitted,
  retireDeletedDetail,
  type DeleteOutcome,
} from "./retireDeletedDetail";

export function useUpstreams(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "upstreams",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: ({ signal }) => upstreams.list(queryScope(scope), params, signal),
    enabled,
  });
}

export function useAllUpstreams(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["upstreams", scope.namespace, "all"],
    queryFn: ({ signal }) => upstreams.listAll(queryScope(scope), signal),
    enabled,
  });
}

export interface UpstreamReferences {
  /** Upstream id to the name a row should display. */
  readonly names: ReadonlyMap<string, string>;
  /** Ids whose read failed. The row shows the raw id, not a wrong name. */
  readonly unresolved: ReadonlySet<string>;
  /** True while any read that could still name an id is in flight. */
  readonly isPending: boolean;
}

/**
 * Name the upstreams referenced by the rows currently on screen.
 *
 * A list page needs `upstream_id -> name` for at most one page of rows, but
 * the admin API has no reference or `id in (...)` query, so there are only two
 * shapes available. This picks between them by measuring, rather than
 * committing to the one that is wrong at scale:
 *
 * - One `GET /upstreams?limit=250`. If the reported total fits in that page
 *   the whole catalog is already in hand for one request, which is strictly
 *   cheaper than per-row reads and is what almost every namespace hits.
 * - Otherwise, one `GET /upstreams/{id}` for each *visible* id the first page
 *   did not already name. That is bounded by the page size — at most ~20
 *   reads — instead of `ceil(total / 250)` pages of a collection the page will
 *   never display. At 50,000 upstreams that is the difference between 200
 *   sequential requests plus 50,000 records held in memory, and a handful of
 *   reads for the rows actually on screen.
 *
 * A failed reference read is a fact about that row, not a fault: it goes to
 * `unresolved` and the row shows the id it is configured with. The global
 * error dialog stays quiet (`upstreams.getReference`).
 */
export function useUpstreamReferences(
  ids: readonly string[],
  enabled = true,
): UpstreamReferences {
  const { scope } = useNamespace();
  // Memoized on the value identity of `ids`, so a caller that rebuilds the
  // array every render does not restart the reference reads every render.
  const key = ids.join("\u0000");
  const distinct = useMemo(
    () => [...new Set(key.split("\u0000").filter(Boolean))].sort(),
    [key],
  );

  const catalog = useQuery({
    queryKey: ["upstreams", scope.namespace, "firstPage", ALL_PAGE_SIZE],
    queryFn: ({ signal }) =>
      upstreams.list(queryScope(scope), { offset: 0, limit: ALL_PAGE_SIZE }, signal),
    enabled,
  });

  const page = catalog.data;
  const catalogIsWholeCollection =
    page !== undefined && page.pagination.total <= page.data.length;

  const named = useMemo(() => {
    const map = new Map<string, string>();
    for (const upstream of page?.data ?? []) map.set(upstream.id, upstream.name ?? upstream.id);
    return map;
  }, [page]);

  // Nothing left to look up once the first page turned out to be everything.
  const missing = useMemo(
    () =>
      catalogIsWholeCollection || page === undefined
        ? []
        : distinct.filter((id) => !named.has(id)),
    [catalogIsWholeCollection, distinct, named, page],
  );

  const references = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["upstreamRef", scope.namespace, id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        upstreams.getReference(queryScope(scope), id, signal),
      enabled,
      retry: false,
    })),
  });

  // Built per render rather than memoized: it is at most one page of entries,
  // and `useQueries` hands back a fresh array anyway, so a memo here would key
  // on a synthetic identity without saving anything real.
  const names = new Map(named);
  const unresolved = new Set<string>();
  missing.forEach((id, index) => {
    const reference = references[index];
    if (reference?.data) names.set(id, reference.data.name ?? reference.data.id);
    else if (reference?.isError) unresolved.add(id);
  });

  return {
    names,
    unresolved,
    isPending:
      catalog.isPending || references.some((reference) => reference.isPending),
  };
}

export function useUpstream(id: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["upstream", scope.namespace, id],
    queryFn: () => upstreams.get(queryScope(scope), id),
    enabled: enabled && !!id,
  });
}

export function useCreateUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (data: UpstreamCreate) => upstreams.create(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["upstreamRef"] });
    },
  });
}

/**
 * Upstream settings save, or a targets-only save.
 *
 * Each variant carries the guard for what it replaces: the settings form
 * compares the whole writable resource, the targets editor compares only
 * `targets`, so a settings save from this same client still composes with a
 * target edit (#235/#254) while a *concurrent* target change is refused.
 */
export function useUpdateUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (input: {
      id: string;
      guard: WriteGuard<Upstream | UpstreamCreate> | null;
    } & ({ data: UpstreamCreate } | { targets: UpstreamCreate["targets"] })) =>
      "targets" in input
        ? upstreams.updateTargets(scope, input.id, input.targets, input.guard)
        : upstreams.update(scope, input.id, input.data, input.guard),
    onSuccess: async (upstream, { id }) => {
      const queryKey = ["upstream", scope.namespace, id];
      await qc.cancelQueries({ queryKey, exact: true });
      qc.setQueryData(queryKey, upstream);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["upstreams", scope.namespace] }),
        qc.invalidateQueries({ queryKey, exact: true }),
        // A rename must reach the list rows that name this upstream.
        qc.invalidateQueries({ queryKey: ["upstreamRef", scope.namespace, id] }),
      ]);
    },
    // A committed-but-not-live save changed the gateway even though it
    // rejects. Reconcile before the caller sees the outcome, so the next
    // targets edit is computed from the committed list, not the previous one.
    onError: async (error, { id }) => {
      if (!isCommittedWrite(error)) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["upstreams", scope.namespace] }),
        qc.invalidateQueries({ queryKey: ["upstream", scope.namespace, id], exact: true }),
        qc.invalidateQueries({ queryKey: ["upstreamRef", scope.namespace, id] }),
      ]);
    },
  });
}

export function useDeleteUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async ({
      id,
      guard,
    }: {
      id: string;
      guard: WriteGuard<Upstream | UpstreamCreate> | null;
    }): Promise<DeleteOutcome> => {
      // A committed-but-not-live answer is a completed delete: its caches are
      // retired below exactly as for a 204.
      const committed = await removeCommitted(() => upstreams.remove(scope, id, guard));
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id, committed };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, ["upstream", retired.namespace, retired.id]);
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["upstreamRef", retired.namespace, retired.id] });
    },
  });
}
