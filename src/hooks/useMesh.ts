/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for mesh observability      */
/*                                                                    */
/*  Mesh endpoints 404 outside mesh mode; hooks disable retries so    */
/*  non-mesh gateways degrade to a friendly empty state quickly.      */
/*                                                                    */
/*  Mesh surfaces are process-level, so cache keys stay namespace-    */
/*  free; each fetch is still bound to the scope current when it      */
/*  started because the BFF authorizes it against namespace grants.   */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as mesh from "@/api/mesh";
import { useNamespace } from "@/stores/namespace";

const MESH_QUERY_OPTS = { retry: false, refetchInterval: 15000 } as const;

export function useServiceGraph() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "serviceGraph"],
    queryFn: () => mesh.getServiceGraph(scope),
    ...MESH_QUERY_OPTS,
  });
}

export function useEgressScope() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "egressScope"],
    queryFn: () => mesh.getEgressScope(scope),
    retry: false,
  });
}

export function useTestEgressScope() {
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ host, port }: { host: string; port?: number }) =>
      mesh.testEgressScope(scope, host, port),
  });
}

export function useFederation() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "federation"],
    queryFn: () => mesh.getFederation(scope),
    retry: false,
  });
}

export function useRemoteClusters() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "remoteClusters"],
    queryFn: () => mesh.getRemoteClusters(scope),
    ...MESH_QUERY_OPTS,
  });
}

export function useConfigDrift() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "configDrift"],
    queryFn: () => mesh.getConfigDrift(scope),
    ...MESH_QUERY_OPTS,
  });
}

export function useResetConfigRevision() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: () => mesh.resetConfigRevision(scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mesh", "configDrift"] });
    },
  });
}

export function useSliceDrift() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "sliceDrift"],
    queryFn: () => mesh.getSliceDrift(scope),
    ...MESH_QUERY_OPTS,
  });
}

export function usePolicyDenies(window = "5m", limit = 50) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "policyDenies", window, limit],
    queryFn: () => mesh.getPolicyDenies(scope, window, limit),
    ...MESH_QUERY_OPTS,
  });
}

export function useNodeWaypointIdentities() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "nodeWaypointIdentities"],
    queryFn: () => mesh.getNodeWaypointIdentities(scope),
    retry: false,
  });
}

export function useServiceWaypointServices() {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["mesh", "serviceWaypointServices"],
    queryFn: () => mesh.getServiceWaypointServices(scope),
    retry: false,
  });
}
