/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for gateway trust bundles   */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as trust from "@/api/trust";
import { useNamespace } from "@/stores/namespace";

export function useTrustBundles() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["trustBundles", ns],
    queryFn: () => trust.list(),
    retry: false,
  });
}

export function useTrustStatus() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["trustStatus", ns],
    queryFn: () => trust.status(),
    retry: false,
  });
}

export function useCreateTrustBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: trust.GatewayTrustBundleCreate) => trust.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}

export function useUpdateTrustBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: trust.GatewayTrustBundleCreate;
    }) => trust.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}

export function useDeleteTrustBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => trust.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}
