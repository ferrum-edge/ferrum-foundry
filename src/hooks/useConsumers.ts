/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Consumers               */
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

export function useConsumers(params: PaginationParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["consumers", ns, { offset: params.offset, limit: params.limit }],
    queryFn: () => consumers.list(params),
  });
}

export function useAllConsumers() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["consumers", ns, "all"],
    queryFn: () => consumers.listAll(),
  });
}

export function useConsumer(id: string) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["consumer", ns, id],
    queryFn: () => consumers.get(id),
    enabled: !!id,
  });
}

export function useCreateConsumer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ConsumerCreate) => consumers.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useUpdateConsumer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ConsumerCreate }) =>
      consumers.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumers"] });
      qc.invalidateQueries({ queryKey: ["consumer"] });
    },
  });
}

export function useDeleteConsumer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consumers.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

// ── Credential mutations ─────────────────────────────────────────

export function useUpdateCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput | ConsumerCredentialInput[];
    }) => consumers.updateCredentials(consumerId, credType, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useAppendCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput;
    }) => consumers.appendCredential(consumerId, credType, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useDeleteCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
    }: {
      consumerId: string;
      credType: string;
    }) => consumers.deleteCredentials(consumerId, credType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

export function useDeleteCredentialByIndex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      consumerId,
      credType,
      index,
    }: {
      consumerId: string;
      credType: string;
      index: number;
    }) => consumers.deleteCredentialByIndex(consumerId, credType, index),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consumer"] });
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}
