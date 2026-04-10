/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Proxies                 */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as proxies from "@/api/proxies";
import type { PaginationParams, ProxyCreate } from "@/api/types";

export function useProxies(params: PaginationParams = {}) {
  return useQuery({
    queryKey: ["proxies", { offset: params.offset, limit: params.limit }],
    queryFn: () => proxies.list(params),
  });
}

export function useProxy(id: string) {
  return useQuery({
    queryKey: ["proxy", id],
    queryFn: () => proxies.get(id),
    enabled: !!id,
  });
}

export function useCreateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProxyCreate) => proxies.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useUpdateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProxyCreate }) =>
      proxies.update(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["proxy", variables.id] });
    },
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => proxies.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}
