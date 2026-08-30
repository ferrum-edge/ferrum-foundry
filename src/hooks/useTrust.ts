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
    queryFn: () => trust.list({}, ns),
    retry: false,
  });
}

export function useTrustStatus() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["trustStatus", ns],
    queryFn: () => trust.status(ns),
    retry: false,
  });
}

export function useCreateTrustBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      namespace,
    }: {
      data: trust.GatewayTrustBundleCreate;
      namespace: string;
    }) => trust.create(data, namespace),
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
      namespace,
    }: {
      id: string;
      data: trust.GatewayTrustBundleCreate;
      namespace: string;
    }) => trust.update(id, data, namespace),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}

export function useDeleteTrustBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, namespace }: { id: string; namespace: string }) =>
      trust.remove(id, namespace),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}
