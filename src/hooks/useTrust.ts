/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for gateway trust bundles   */
/*                                                                    */
/*  Queries bind to the active namespace scope. Mutations take the    */
/*  namespace the editor captured when it opened, so the bundle lands */
/*  in the namespace the dialog names even if the selector moved.     */
/* ------------------------------------------------------------------ */

import { queryScope } from "@/api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as trust from "@/api/trust";
import { useNamespace } from "@/stores/namespace";

export function useTrustBundles() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["trustBundles", scope.namespace],
    queryFn: () => trust.list(queryScope(scope)),
    retry: false,
  });
}

export function useTrustStatus() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["trustStatus", scope.namespace],
    queryFn: () => trust.status(queryScope(scope)),
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
    }) => trust.create({ namespace }, data),
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
    }) => trust.update({ namespace }, id, data),
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
      trust.remove({ namespace }, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trustBundles"] });
      qc.invalidateQueries({ queryKey: ["trustStatus"] });
    },
  });
}
