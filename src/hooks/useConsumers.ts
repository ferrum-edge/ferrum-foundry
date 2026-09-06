/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Consumers               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as consumers from "@/api/consumers";
import type {
  BuiltInCredentialType,
  ConsumerCreate,
  ConsumerCredentialInput,
  PaginationParams,
} from "@/api/types";
import { useNamespace } from "@/stores/namespace";

export function useConsumers(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "consumers",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: () => consumers.list(scope, params),
    enabled,
  });
}

export function useAllConsumers(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["consumers", scope.namespace, "all"],
    queryFn: () => consumers.listAll(scope),
    enabled,
  });
}

export function useConsumer(id: string) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["consumer", scope.namespace, id],
    queryFn: () => consumers.get(scope, id),
    enabled: !!id,
  });
}

export function useCreateConsumer() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    // Discard submitted secret variables as soon as the form resets/unmounts.
    gcTime: 0,
    mutationFn: (data: ConsumerCreate) => consumers.create(scope, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useUpdateConsumer() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ConsumerCreate }) =>
      consumers.update(scope, id, data),
    onSuccess: async (consumer, { id }) => {
      const queryKey = ["consumer", scope.namespace, id];
      await qc.cancelQueries({ queryKey, exact: true });
      qc.setQueryData(queryKey, consumer);
      // Keep the mutation pending through reconciliation, so a second ACL
      // edit uses the accepted group list instead of the previous render.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["consumers", scope.namespace] }),
        qc.invalidateQueries({ queryKey, exact: true }),
      ]);
    },
  });
}

export function useDeleteConsumer() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async (id: string) => {
      await consumers.remove(scope, id);
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id };
    },
    onSuccess: (retired) => {
      qc.removeQueries({ queryKey: ["consumer", retired.namespace, retired.id], exact: true });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

// ── Credential mutations ─────────────────────────────────────────

export function useUpdateCredentials() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput | ConsumerCredentialInput[];
    }) => consumers.updateCredentials(scope, consumerId, credType, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useAppendCredential() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput;
    }) => consumers.appendCredential(scope, consumerId, credType, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useDeleteCredentials() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
    }: {
      consumerId: string;
      credType: string;
    }) => consumers.deleteCredentials(scope, consumerId, credType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useDeleteCredentialByIndex() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
      index,
    }: {
      consumerId: string;
      credType: string;
      index: number;
    }) => consumers.deleteCredentialByIndex(scope, consumerId, credType, index),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}
