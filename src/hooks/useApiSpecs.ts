/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for API specs               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as apiSpecs from "@/api/apiSpecs";
import { useNamespace } from "@/stores/namespace";

export function useApiSpecs(
  params: apiSpecs.ApiSpecListParams = {},
  enabled = true,
) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecs", scope.namespace, params],
    queryFn: () => apiSpecs.list(scope, params),
    retry: false,
    enabled,
  });
}

export function useAllApiSpecs(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecs", scope.namespace, "all"],
    queryFn: () => apiSpecs.listAll(scope),
    enabled,
    retry: false,
  });
}

export function useApiSpecDocument(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecDocument", scope.namespace, id],
    queryFn: () => apiSpecs.getDocument(scope, id),
    enabled: !!id,
    retry: false,
  });
}

export function useImportApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (document: string) => apiSpecs.create(scope, document),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apiSpecs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useUpdateApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ id, document }: { id: string; document: string }) =>
      apiSpecs.update(scope, id, document),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apiSpecs"] });
      qc.invalidateQueries({ queryKey: ["apiSpecDocument"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}

export function useDeleteApiSpec() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: (id: string) => apiSpecs.remove(scope, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apiSpecs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}
