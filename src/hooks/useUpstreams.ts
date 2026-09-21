/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Upstreams               */
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
import * as upstreams from "@/api/upstreams";
import type { WriteGuard } from "@/api/conditionalWrite";
import type { PaginationParams, Upstream, UpstreamCreate } from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import { retireDeletedDetail } from "./retireDeletedDetail";

export function useUpstreams(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "upstreams",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: () => upstreams.list(queryScope(scope), params),
    enabled,
  });
}

export function useAllUpstreams(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["upstreams", scope.namespace, "all"],
    queryFn: () => upstreams.listAll(queryScope(scope)),
    enabled,
  });
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
      ]);
    },
  });
}

export function useDeleteUpstream() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async (id: string) => {
      await upstreams.remove(scope, id);
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, ["upstream", retired.namespace, retired.id]);
      qc.invalidateQueries({ queryKey: ["upstreams"] });
    },
  });
}
