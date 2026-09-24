/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Consumers               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import {
  committedWriteMessage,
  getCommittedWrite,
  isCommittedWrite,
  isUnobservedWrite,
  markCommittedWrite,
  markUnobservedWrite,
  queryScope,
  UNOBSERVED_WRITE_MESSAGE,
} from "@/api/client";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as consumers from "@/api/consumers";
import type { WriteGuard } from "@/api/conditionalWrite";
import type {
  BuiltInCredentialType,
  Consumer,
  ConsumerCreate,
  ConsumerCredentialInput,
  PaginationParams,
} from "@/api/types";
import { useNamespace } from "@/stores/namespace";
import {
  removeCommitted,
  retireDeletedDetail,
  type DeleteOutcome,
} from "./retireDeletedDetail";

export function useConsumers(params: PaginationParams = {}, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: [
      "consumers",
      scope.namespace,
      { offset: params.offset, limit: params.limit },
    ],
    queryFn: ({ signal }) => consumers.list(queryScope(scope), params, signal),
    enabled,
  });
}

export function useAllConsumers(enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["consumers", scope.namespace, "all"],
    queryFn: ({ signal }) => consumers.listAll(queryScope(scope), signal),
    enabled,
  });
}

export function useConsumer(id: string, enabled = true) {
  const { scope } = useNamespace();
  return useQuery({
    queryKey: ["consumer", scope.namespace, id],
    queryFn: () => consumers.get(queryScope(scope), id),
    enabled: enabled && !!id,
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
    mutationFn: ({
      id,
      data,
      guard,
    }: {
      id: string;
      data: ConsumerCreate;
      guard: WriteGuard<Consumer | ConsumerCreate> | null;
    }) => consumers.update(scope, id, data, guard),
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
    // A committed-but-not-live save changed the gateway even though it
    // rejects. Reconcile the same way before the caller sees the outcome, so a
    // second ACL edit uses the committed group list.
    onError: async (error, { id }) => {
      if (!isCommittedWrite(error)) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["consumers", scope.namespace] }),
        qc.invalidateQueries({ queryKey: ["consumer", scope.namespace, id], exact: true }),
      ]);
    },
  });
}

export function useDeleteConsumer() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    mutationFn: async ({
      id,
      guard,
    }: {
      id: string;
      guard: WriteGuard<Consumer | ConsumerCreate> | null;
    }): Promise<DeleteOutcome> => {
      // A committed-but-not-live answer is a completed delete: its caches are
      // retired below exactly as for a 204.
      const committed = await removeCommitted(() => consumers.remove(scope, id, guard));
      // Carry the mutation's namespace through completion, even after a switch.
      return { namespace: scope.namespace, id, committed };
    },
    onSuccess: async (retired) => {
      await retireDeletedDetail(qc, ["consumer", retired.namespace, retired.id]);
      qc.invalidateQueries({ queryKey: ["consumers"] });
    },
  });
}

// ── Credential mutations ─────────────────────────────────────────

export function useUpdateCredentials() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput | ConsumerCredentialInput[];
    }) => {
      try {
        await consumers.updateCredentials(scope, consumerId, credType, data);
      } catch (error) {
        // Do not retain a ky error containing the password-bearing Request or
        // an echoed response body in the mutation cache. A lost answer keeps
        // its unknown-outcome marker so cached reads are still refreshed.
        if (isUnobservedWrite(error)) throw markUnobservedWrite(new Error(UNOBSERVED_WRITE_MESSAGE));
        // A committed-but-not-live answer keeps its marker too: the credentials
        // were replaced, so it is not reported as a failure.
        const committed = getCommittedWrite(error);
        if (committed) {
          throw markCommittedWrite(
            new Error(committedWriteMessage("Credentials replaced", committed)),
            committed,
          );
        }
        // eslint-disable-next-line preserve-caught-error -- the cause is the secret-bearing error
        throw new Error("Credential replacement failed. Check the gateway state before retrying.");
      }
      return { namespace: scope.namespace, consumerId };
    },
    onSuccess: ({ namespace, consumerId }) => Promise.all([
      qc.invalidateQueries({ queryKey: ["consumer", namespace, consumerId], exact: true }),
      qc.invalidateQueries({ queryKey: ["consumers", namespace] }),
    ]).then(() => undefined),
  });
}

export function useAppendCredential() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({
      consumerId,
      credType,
      data,
    }: {
      consumerId: string;
      credType: BuiltInCredentialType;
      data: ConsumerCredentialInput;
    }) => {
      await consumers.appendCredential(scope, consumerId, credType, data);
      return { namespace: scope.namespace, consumerId };
    },
    onSuccess: ({ namespace, consumerId }) => Promise.all([
      qc.invalidateQueries({ queryKey: ["consumer", namespace, consumerId], exact: true }),
      qc.invalidateQueries({ queryKey: ["consumers", namespace] }),
    ]).then(() => undefined),
  });
}

export function useDeleteCredentials() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({
      consumerId,
      credType,
    }: {
      consumerId: string;
      credType: string;
    }) => {
      await consumers.deleteCredentials(scope, consumerId, credType);
      return { namespace: scope.namespace, consumerId };
    },
    onSuccess: ({ namespace, consumerId }) => Promise.all([
      qc.invalidateQueries({ queryKey: ["consumer", namespace, consumerId], exact: true }),
      qc.invalidateQueries({ queryKey: ["consumers", namespace] }),
    ]).then(() => undefined),
  });
}

export function useDeleteCredentialByIndex() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({
      consumerId,
      credType,
      index,
    }: {
      consumerId: string;
      credType: string;
      index: number;
    }) => {
      await consumers.deleteCredentialByIndex(scope, consumerId, credType, index);
      return { namespace: scope.namespace, consumerId };
    },
    onSuccess: ({ namespace, consumerId }) => Promise.all([
      qc.invalidateQueries({ queryKey: ["consumer", namespace, consumerId], exact: true }),
      qc.invalidateQueries({ queryKey: ["consumers", namespace] }),
    ]).then(() => undefined),
  });
}
