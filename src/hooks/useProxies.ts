/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Proxies                 */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { isCommittedWrite, queryScope } from "@/api/client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ALL_PAGE_SIZE } from "@/api/pagination";
import * as proxies from "@/api/proxies";
import type { WriteGuard } from "@/api/conditionalWrite";
import type { PaginationParams, Proxy, ProxyCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import { retireCascade, type CascadeKind } from "./retireCascade";
import {
  removeCommitted,
  retireDeletedDetail,
  type DeleteOutcome,
} from "./retireDeletedDetail";

/**
 * `DELETE /proxies/{id}` cascades: the proxy's plugin configs (spec-owned and
 * hand-added), an owning API spec row, and a last-referenced hand-owned
 * upstream that is orphan-cleaned. The proxy's own detail entry is retired by
 * exact id; the cascaded kinds have no client-known ids, so they go by prefix.
 */
const PROXY_DELETE_CASCADE: readonly CascadeKind[] = [
  "pluginConfig",
  "upstream",
  "apiSpecDocument",
];

export function useProxies(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "proxies",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: ({ signal }) => proxies.list(queryScope(scope), params, signal),
    enabled,
  });
}

/**
 * The complete proxy collection.
 *
 * `GET /proxies` has no search parameter, so a search term still has to be
 * answered by traversing the collection (`docs/data-loading.md`). The
 * traversal now receives the Query's `signal`, so a namespace switch, a new
 * search term, or leaving the page abandons the remaining pages instead of
 * paying for results nobody will read.
 */
export function useAllProxies(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["proxies", scope.namespace, "all"],
    queryFn: ({ signal }) => proxies.listAll(queryScope(scope), signal),
    enabled,
  });
}

export interface ProxyCatalog {
  /** Proxies available to choose from right now. */
  readonly proxies: Proxy[];
  /** How many the namespace holds in total. */
  readonly total: number;
  /** True when `proxies` is every proxy in the namespace. */
  readonly complete: boolean;
  /**
   * The read the picker is gated on. A supplementary membership read that
   * fails must disable the picker and offer a retry without changing the
   * form's identity or its initialized state (#299), so this is handed back
   * for `resolveReadState` and `ReadStateNotice` rather than flattened into a
   * boolean.
   */
  readonly query: UseQueryResult<unknown>;
  /** True while an explicit "search all" traversal is still running. */
  readonly expanding: boolean;
}

/**
 * Proxies for a picker, bounded by default and complete on request.
 *
 * One `GET /proxies?limit=250` answers almost every namespace outright — if
 * the reported total fits in that page, the catalog *is* complete after a
 * single request. Only when it does not does the picker need a choice, and
 * the admin API offers no search parameter to make that choice cheap, so the
 * expensive option is made explicit rather than taken silently: the picker
 * offers to search the whole collection and `expanded` starts the traversal,
 * which stays cancellable.
 */
export function useProxyCatalog(expanded: boolean): ProxyCatalog {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  const firstPage = useQuery({
    queryKey: ["proxies", scope.namespace, "firstPage", ALL_PAGE_SIZE],
    queryFn: ({ signal }) =>
      proxies.list(queryScope(scope), { offset: 0, limit: ALL_PAGE_SIZE }, signal),
  });
  const page = firstPage.data;
  const firstPageIsWholeCollection =
    page !== undefined && page.pagination.total <= page.data.length;

  const traversing = expanded && page !== undefined && !firstPageIsWholeCollection;
  const everything = useAllProxies(traversing);

  // The full list stays cached after a search, and a write invalidates it
  // without refetching while it is disabled (#611). Such an entry may not be
  // the collection any more, so it answers only while it is valid:
  //   - not invalidated;
  //   - at least as recent as the first page, or kept current by an enabled
  //     observer (a membership editor, or this picker expanded), which
  //     TanStack refetches on invalidation and refocus;
  //   - in agreement with the first page, once there is one: its length is
  //     the page's total, and every row on the page is in it by the same name.
  // Otherwise the first page answers, with its own total, completeness and
  // errors, so "Search all" is offered again. Invalidating a disabled query
  // notifies no observer, so its state is read through a cache subscription
  // that re-renders the picker when it changes.
  const subscribe = useCallback(
    (onChange: () => void) => qc.getQueryCache().subscribe(onChange),
    [qc],
  );
  const fullListInvalidated = useSyncExternalStore(
    subscribe,
    () => qc.getQueryState(["proxies", scope.namespace, "all"])?.isInvalidated === true,
  );
  const fullListObserved = useSyncExternalStore(
    subscribe,
    () => qc.getQueryCache()
      .find({ queryKey: ["proxies", scope.namespace, "all"], exact: true })
      ?.isActive() === true,
  );
  const fullListAgrees = useMemo(() => {
    const all = everything.data;
    if (all === undefined) return false;
    if (page === undefined) return true;
    if (all.length !== page.pagination.total) return false;
    const names = new Map(all.map((entry) => [entry.id, entry.name]));
    return page.data.every((entry) => names.has(entry.id) && names.get(entry.id) === entry.name);
  }, [everything.data, page]);
  const fullListNewer = everything.dataUpdatedAt >= firstPage.dataUpdatedAt;
  const fullListValid =
    everything.data !== undefined &&
    !fullListInvalidated &&
    fullListAgrees &&
    (fullListNewer || fullListObserved);

  // Expanded, the operator asked for the whole collection, so a list that is
  // not valid is fetched again whatever the stale timer says. When the list is
  // the newer read and the first page disagrees with it, the page is the stale
  // one and is read again instead. Each read triggers at most one follow-up,
  // and a failed one stops here and surfaces as the answering query's error.
  const repair: "all" | "page" | null = !traversing || fullListValid
    ? null
    : everything.data !== undefined && !fullListInvalidated && fullListNewer
      ? "page"
      : "all";
  const { refetch: refetchAll } = everything;
  const { refetch: refetchPage } = firstPage;
  useEffect(() => {
    // `cancelRefetch: false` joins a read the query already started.
    if (repair === "all") void refetchAll({ cancelRefetch: false });
    else if (repair === "page") void refetchPage({ cancelRefetch: false });
  }, [repair, everything.dataUpdatedAt, firstPage.dataUpdatedAt, refetchAll, refetchPage]);

  // Whichever read actually supplied the rows is the one the picker's state
  // must reflect, so a failure of *that* read is what disables it.
  if (everything.data && fullListValid) {
    return {
      proxies: everything.data,
      total: everything.data.length,
      complete: true,
      query: everything,
      expanding: false,
    };
  }
  return {
    proxies: page?.data ?? [],
    total: page?.pagination.total ?? 0,
    complete: firstPageIsWholeCollection,
    // The first page answers here, so its own failure is reported first.
    query: !firstPage.isError && everything.isError ? everything : firstPage,
    expanding: everything.isFetching,
  };
}

/**
 * Labels for proxy ids a picker holds but has not loaded — a selection on a
 * page the picker never fetched, or one the gateway no longer has. Bounded by
 * the number of selections, and never more than one read per id.
 */
export function useProxyReferences(ids: readonly string[]): {
  names: ReadonlyMap<string, string>;
  /** The gateway answered 404: the proxy is not in this namespace any more. */
  missing: ReadonlySet<string>;
  /** The read failed for another reason. Nothing is known about the proxy. */
  unresolved: ReadonlySet<string>;
} {
  const { scope } = useNamespace();
  const key = ids.join("\u0000");
  const distinct = useMemo(
    () => [...new Set(key.split("\u0000").filter(Boolean))].sort(),
    [key],
  );

  const references = useQueries({
    queries: distinct.map((id) => ({
      queryKey: ["proxyRef", scope.namespace, id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        proxies.getReference(queryScope(scope), id, signal),
      retry: false,
    })),
  });

  const names = new Map<string, string>();
  const missing = new Set<string>();
  const unresolved = new Set<string>();
  distinct.forEach((id, index) => {
    const reference = references[index];
    if (reference?.data) names.set(id, describeProxy(reference.data));
    else if (reference?.isError) {
      // Only a 404 says the proxy is gone. A 503 or a dropped connection says
      // nothing about it, and must not be reported as a deletion.
      if (errorStatus(reference.error) === 404) missing.add(id);
      else unresolved.add(id);
    }
  });
  return { names, missing, unresolved };
}

function errorStatus(error: unknown): number | undefined {
  const response = (error as { response?: { status?: unknown } } | null)?.response;
  return typeof response?.status === "number" ? response.status : undefined;
}

/** The label a picker shows for a proxy: its name, else how it listens. */
export function describeProxy(proxy: Proxy): string {
  const path = proxy.listen_path ?? (proxy.listen_port ? `:${proxy.listen_port}` : proxy.id);
  return proxy.name ? `${proxy.name} (${path})` : path;
}

export function useProxy(id: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["proxy", scope.namespace, id],
    queryFn: () => proxies.get(queryScope(scope), id),
    enabled: enabled && !!id,
  });
}

export function useCreateProxy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted inline TLS key material as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: (data: ProxyCreate) => proxies.create(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["proxyRef"] });
    },
  });
}

/**
 * Full-replacement proxy save.
 *
 * `guard` is the content the editor was seeded with. It is not optional: a
 * save that cannot name what it is replacing is the cross-session overwrite
 * this mutation refuses to perform. Pass `null` only from a caller that
 * provably cannot lose a concurrent change.
 */
export function useUpdateProxy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted inline TLS key material as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: ({ id, data, guard }: {
      id: string;
      data: ProxyCreate;
      guard: WriteGuard<Proxy | ProxyCreate> | null;
    }) => proxies.update(scope, id, data, guard),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["proxy"] });
      qc.invalidateQueries({ queryKey: ["proxyRef"] });
    },
    // A committed-but-not-live save changed the gateway even though it
    // rejects: reconcile before the caller sees the outcome, as for a success.
    onError: async (error) => {
      if (!isCommittedWrite(error)) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["proxies"] }),
        qc.invalidateQueries({ queryKey: ["proxy"] }),
        qc.invalidateQueries({ queryKey: ["proxyRef"] }),
      ]);
    },
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // The guard's baseline can carry secrets: discard it once the page is gone.
    gcTime: 0,
    mutationFn: async ({
      id,
      guard,
    }: {
      id: string;
      guard: WriteGuard<Proxy | ProxyCreate> | null;
    }): Promise<DeleteOutcome> => {
      // A committed-but-not-live answer is a completed delete: its caches are
      // retired below exactly as for a 204.
      const committed = await removeCommitted(() => proxies.remove(scope, id, guard));
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id, committed };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, ["proxy", retired.namespace, retired.id]);
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["proxyRef", retired.namespace, retired.id] });
      retireCascade(qc, retired.namespace, PROXY_DELETE_CASCADE);
    },
  });
}
