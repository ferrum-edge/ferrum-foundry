/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Upstreams               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as upstreams from "@/api/upstreams";
import type { PaginationParams, UpstreamCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";

export function useUpstreams(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "upstreams",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: () => upstreams.list(scope, params),
    enabled,
  });
}

export function useAllUpstreams(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["upstreams", scope.namespace, "all"],
    queryFn: () => upstreams.listAll(scope),
    enabled,
  });
}

export function useUpstream(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["upstream", scope.namespace, id],
    queryFn: () => upstreams.get(scope, id),
    enabled: !!id,
  });
}

export function useCreateUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (data: UpstreamCreate) => upstreams.create(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
    },
  });
}

export function useUpdateUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpstreamCreate }) =>
      upstreams.update(scope, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["upstream"] });
    },
  });
}

export function useDeleteUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (id: string) => upstreams.remove(scope, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
    },
  });
}
