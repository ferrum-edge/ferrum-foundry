/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for API specs               */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as apiSpecs from "@/api/apiSpecs";
import { useNamespace } from "@/stores/namespace";

export function useApiSpecs(params: apiSpecs.ApiSpecListParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecs", ns, params],
    queryFn: () => apiSpecs.list(params),
    retry: false,
  });
}

export function useApiSpecDocument(id: string) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["apiSpecDocument", ns, id],
    queryFn: () => apiSpecs.getDocument(id),
    enabled: !!id,
    retry: false,
  });
}

export function useImportApiSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (document: string) => apiSpecs.create(document),
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
  return useMutation({
    mutationFn: ({ id, document }: { id: string; document: string }) =>
      apiSpecs.update(id, document),
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
  return useMutation({
    mutationFn: (id: string) => apiSpecs.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apiSpecs"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["upstreams"] });
      qc.invalidateQueries({ queryKey: ["pluginConfigs"] });
    },
  });
}
