/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Upstreams               */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as upstreams from "@/api/upstreams";
import type { PaginationParams, UpstreamCreate } from "@/api/types";

export function useUpstreams(params: PaginationParams = {}) {
  return useQuery({
    queryKey: ["upstreams", { offset: params.offset, limit: params.limit }],
    queryFn: () => upstreams.list(params),
  });
}

export function useUpstream(id: string) {
  return useQuery({
    queryKey: ["upstream", id],
    queryFn: () => upstreams.get(id),
    enabled: !!id,
  });
}

export function useCreateUpstream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpstreamCreate) => upstreams.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
    },
  });
}

export function useUpdateUpstream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpstreamCreate }) =>
      upstreams.update(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["upstream", variables.id] });
    },
  });
}

export function useDeleteUpstream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => upstreams.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["upstreams"] });
    },
  });
}
