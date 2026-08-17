/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for mesh observability      */
/*                                                                    */
/*  Mesh endpoints 404 outside mesh mode; hooks disable retries so    */
/*  non-mesh gateways degrade to a friendly empty state quickly.      */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as mesh from "@/api/mesh";

const MESH_QUERY_OPTS = { retry: false, refetchInterval: 15000 } as const;

export function useServiceGraph() {
  return useQuery({
    queryKey: ["mesh", "serviceGraph"],
    queryFn: () => mesh.getServiceGraph(),
    ...MESH_QUERY_OPTS,
  });
}

export function useEgressScope() {
  return useQuery({
    queryKey: ["mesh", "egressScope"],
    queryFn: () => mesh.getEgressScope(),
    retry: false,
  });
}

export function useTestEgressScope() {
  return useMutation({
    mutationFn: ({ host, port }: { host: string; port?: number }) =>
      mesh.testEgressScope(host, port),
  });
}

export function useFederation() {
  return useQuery({
    queryKey: ["mesh", "federation"],
    queryFn: () => mesh.getFederation(),
    retry: false,
  });
}

export function useRemoteClusters() {
  return useQuery({
    queryKey: ["mesh", "remoteClusters"],
    queryFn: () => mesh.getRemoteClusters(),
    ...MESH_QUERY_OPTS,
  });
}

export function useConfigDrift() {
  return useQuery({
    queryKey: ["mesh", "configDrift"],
    queryFn: () => mesh.getConfigDrift(),
    ...MESH_QUERY_OPTS,
  });
}

export function useResetConfigRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => mesh.resetConfigRevision(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mesh", "configDrift"] });
    },
  });
}

export function useSliceDrift() {
  return useQuery({
    queryKey: ["mesh", "sliceDrift"],
    queryFn: () => mesh.getSliceDrift(),
    ...MESH_QUERY_OPTS,
  });
}

export function usePolicyDenies(window = "5m", limit = 50) {
  return useQuery({
    queryKey: ["mesh", "policyDenies", window, limit],
    queryFn: () => mesh.getPolicyDenies(window, limit),
    ...MESH_QUERY_OPTS,
  });
}

export function useNodeWaypointIdentities() {
  return useQuery({
    queryKey: ["mesh", "nodeWaypointIdentities"],
    queryFn: () => mesh.getNodeWaypointIdentities(),
    retry: false,
  });
}

export function useServiceWaypointServices() {
  return useQuery({
    queryKey: ["mesh", "serviceWaypointServices"],
    queryFn: () => mesh.getServiceWaypointServices(),
    retry: false,
  });
}
