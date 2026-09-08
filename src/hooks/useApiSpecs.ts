/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for API specs               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as apiSpecs from "@/api/apiSpecs";
import { useNamespace } from "@/stores/namespace";
import { retireCascade, type CascadeKind } from "./retireCascade";

/**
 * `POST /api-specs` creates, `PUT /api-specs/{id}` deletes and re-creates
 * (keeping the submitted proxy id), and `DELETE /api-specs/{id}` cascades —
 * every one of them can leave a superseded detail entry behind for a resource
 * of another type that still answers to the same id. Retire all four.
 */
const SPEC_CASCADE: readonly CascadeKind[] = [
  "proxy",
  "upstream",
  "pluginConfig",
  "apiSpecDocument",
];

export function useApiSpecs(
  params: apiSpecs.ApiSpecListParams = {},
  enabled = true,
) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecs", scope.namespace, params],
    queryFn: () => apiSpecs.list(queryScope(scope), params),
    retry: false,
    enabled,
  });
}

export function useAllApiSpecs(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecs", scope.namespace, "all"],
    queryFn: () => apiSpecs.listAll(queryScope(scope)),
    enabled,
    retry: false,
  });
}

export function useApiSpecDocument(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecDocument", scope.namespace, id],
    queryFn: () => apiSpecs.getDocument(queryScope(scope), id),
    enabled: !!id,
    retry: false,
  });
}

export function useImportApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    retry: false,
    mutationFn: async (document: string) => {
      const created = await apiSpecs.create(scope, document);
      // Carry the mutation's namespace through completion, even after a switch.
      return { ...created, namespace: scope.namespace };
    },
    onSuccess: (created) => {
      retireCascade(qc, created.namespace, SPEC_CASCADE);
    },
  });
}

export function useUpdateApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    retry: false,
    mutationFn: async ({ id, document }: { id: string; document: string }) => {
      const replaced = await apiSpecs.update(scope, id, document);
      return { ...replaced, namespace: scope.namespace };
    },
    onSuccess: (replaced) => {
      retireCascade(qc, replaced.namespace, SPEC_CASCADE);
    },
  });
}

export function useDeleteApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiSpecs.remove(scope, id);
      return { namespace: scope.namespace, id };
    },
    onSuccess: (retired) => {
      retireCascade(qc, retired.namespace, SPEC_CASCADE);
    },
  });
}
