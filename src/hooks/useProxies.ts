/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Proxies                 */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import { useMemo } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ALL_PAGE_SIZE } from "@/api/pagination";
import * as proxies from "@/api/proxies";
import type { PaginationParams, Proxy, ProxyCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import { retireCascade, type CascadeKind } from "./retireCascade";
import { retireDeletedDetail } from "./retireDeletedDetail";

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
  const { scope } = useNamespace();
  const firstPage = useQuery({
    queryKey: ["proxies", scope.namespace, "firstPage", ALL_PAGE_SIZE],
    queryFn: ({ signal }) =>
      proxies.list(queryScope(scope), { offset: 0, limit: ALL_PAGE_SIZE }, signal),
  });
  const page = firstPage.data;
  const firstPageIsWholeCollection =
    page !== undefined && page.pagination.total <= page.data.length;

  const everything = useAllProxies(expanded && page !== undefined && !firstPageIsWholeCollection);

  // Whichever read actually supplied the rows is the one the picker's state
  // must reflect, so a failure of *that* read is what disables it.
  if (everything.data) {
    return {
      proxies: everything.data,
      total: everything.data.length,
      complete: true,
      query: everything,
    };
  }
  return {
    proxies: page?.data ?? [],
    total: page?.pagination.total ?? 0,
    complete: firstPageIsWholeCollection,
    query: everything.isError ? everything : firstPage,
  };
}

/**
 * Labels for proxy ids a picker holds but has not loaded — a selection on a
 * page the picker never fetched, or one the gateway no longer has. Bounded by
 * the number of selections, and never more than one read per id.
 */
export function useProxyReferences(ids: readonly string[]): {
  names: ReadonlyMap<string, string>;
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
  const unresolved = new Set<string>();
  distinct.forEach((id, index) => {
    const reference = references[index];
    if (reference?.data) names.set(id, describeProxy(reference.data));
    else if (reference?.isError) unresolved.add(id);
  });
  return { names, unresolved };
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
    mutationFn: (data: ProxyCreate) => proxies.create(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useUpdateProxy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProxyCreate }) =>
      proxies.update(scope, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["proxy"] });
    },
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async (id: string) => {
      await proxies.remove(scope, id);
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, ["proxy", retired.namespace, retired.id]);
      qc.invalidateQueries({ queryKey: ["proxies"] });
      retireCascade(qc, retired.namespace, PROXY_DELETE_CASCADE);
    },
  });
}
