/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Namespaces              */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import * as namespaces from "@/api/namespaces";
import type { NamespaceCreate, NamespaceUpdate } from "@/api/namespaces";

/**
 * Reconcile the query cache after a namespace mutation.
 *
 * `nextName` is the name the namespace now has, or `null` when it was
 * deleted. A retired name (renamed away, or deleted) has its detail key
 * *removed* rather than invalidated: invalidating would refetch a name the
 * gateway no longer resolves and surface a spurious 404 to the user.
 */
export function reconcileNamespaceCache(
  qc: QueryClient,
  previousName: string,
  nextName: string | null,
): void {
  qc.invalidateQueries({ queryKey: ["namespaces"] });

  if (nextName !== previousName) {
    qc.removeQueries({ queryKey: ["namespace", previousName] });
  }
  if (nextName) {
    qc.invalidateQueries({ queryKey: ["namespace", nextName] });
  }
}

export function useNamespaces() {
  return useQuery({
    queryKey: ["namespaces"],
    queryFn: () => namespaces.list(),
    refetchOnWindowFocus: false,
  });
}

export function useNamespaceDetail(name: string) {
  return useQuery({
    queryKey: ["namespace", name],
    queryFn: () => namespaces.get(name),
    enabled: !!name,
    refetchOnWindowFocus: false,
  });
}

/**
 * Count what a cascade delete of `name` would destroy. Disabled until the
 * gateway has actually refused an unconfirmed delete, so opening the delete
 * dialog costs no requests.
 */
export function useNamespaceOccupancy(name: string | null) {
  return useQuery({
    queryKey: ["namespace-occupancy", name],
    queryFn: () => namespaces.getOccupancy(name!),
    enabled: !!name,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useCreateNamespace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: NamespaceCreate) => namespaces.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["namespaces"] });
    },
  });
}

export function useUpdateNamespace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, data }: { name: string; data: NamespaceUpdate }) =>
      namespaces.update(name, data),
    onSuccess: (updated, { name }) => {
      reconcileNamespaceCache(qc, name, updated.name);
    },
  });
}

export function useDeleteNamespace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, confirm }: { name: string; confirm?: boolean }) =>
      namespaces.remove(name, { confirm }),
    onSuccess: (_result, { name }) => {
      reconcileNamespaceCache(qc, name, null);
    },
  });
}
