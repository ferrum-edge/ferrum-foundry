/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Proxies                 */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as proxies from "@/api/proxies";
import type { PaginationParams, ProxyCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import { retireCascade, type CascadeKind } from "./retireCascade";

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
    queryFn: () => proxies.list(queryScope(scope), params),
    enabled,
  });
}

export function useAllProxies(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["proxies", scope.namespace, "all"],
    queryFn: () => proxies.listAll(queryScope(scope)),
    enabled,
  });
}

export function useProxy(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["proxy", scope.namespace, id],
    queryFn: () => proxies.get(queryScope(scope), id),
    enabled: !!id,
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
    onSuccess: (retired) => {
      qc.removeQueries({ queryKey: ["proxy", retired.namespace, retired.id], exact: true });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      retireCascade(qc, retired.namespace, PROXY_DELETE_CASCADE);
    },
  });
}
