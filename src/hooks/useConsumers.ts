/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for Consumers               */
/*                                                                    */
/*  Every hook captures `scope` from the namespace provider and binds */
/*  the whole operation — the query, a mutation and its follow-ups —  */
/*  to it. A mutation reads the scope at `mutate()` time, so a switch */
/*  after the click cannot retarget the write.                        */
/* ------------------------------------------------------------------ */

import {
  getCommittedWrite,
  isCommittedWrite,
  isUnobservedWrite,
  markUnobservedWrite,
  queryScope,
  UNOBSERVED_WRITE_MESSAGE,
} from "@/api/client";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import * as consumers from "@/api/consumers";
import {
  redactedErrorDetail,
  redactionForms,
  redactSubmitted,
  submittedValues,
} from "@/api/secretRedaction";
import type { WriteGuard } from "@/api/conditionalWrite";
import type { CommittedWrite } from "@/api/gatewayMetadata";
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

/** What a credential write reports once the gateway holds it. */
export interface CredentialWriteOutcome {
  /** The namespace the write was issued under, even after a switch. */
  readonly namespace: string;
  readonly consumerId: string;
  /**
   * Set when the gateway answered the committed-but-not-live `503`: the write
   * is durable and only the live apply lagged. `null` for an ordinary `2xx`.
   */
  readonly committed: CommittedWrite | null;
}

function refreshConsumer(qc: QueryClient, namespace: string, consumerId: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["consumer", namespace, consumerId], exact: true }),
    qc.invalidateQueries({ queryKey: ["consumers", namespace] }),
  ]).then(() => undefined);
}

/**
 * A credential write whose answer was lost. `revision` is the consumer read's
 * `dataUpdatedAt` when the lost answer arrived, before this write's own
 * re-read: the form stays locked until a read newer than it succeeds. The
 * revision the form rendered when the write was issued is not a substitute —
 * a refetch that lands mid-write advances it, and a failed re-read would then
 * unlock the form on a read that predates the error (#466).
 */
export class UnobservedCredentialWriteError extends Error {
  readonly revision: number;

  constructor(revision: number) {
    super(UNOBSERVED_WRITE_MESSAGE);
    this.name = "UnobservedCredentialWriteError";
    this.revision = revision;
    markUnobservedWrite(this);
  }
}

/**
 * Run a credential write, resolving a committed-but-not-live answer as the
 * completed write it is rather than as a failure (#451). The mutation then
 * refreshes the consumer exactly as for a `2xx`, and the form closes instead
 * of staying armed to submit the same secret again.
 *
 * A write whose answer was lost refreshes the consumer before it rejects, so
 * the form's retry is judged against a re-read rather than the pre-write list.
 * No outcome rethrows the ky error: it holds the secret-bearing request
 * options and possibly an echoed body, and would otherwise be retained in the
 * mutation cache. A definite pre-commit failure is replaced with a plain
 * error carrying the gateway's detail with every submitted value removed
 * (#466), or with `failure` when the caller must not surface gateway detail.
 */
async function writeCredential(
  qc: QueryClient,
  namespace: string,
  consumerId: string,
  submitted: unknown,
  write: () => Promise<unknown>,
  failure?: string,
): Promise<CredentialWriteOutcome> {
  try {
    await write();
    return { namespace, consumerId, committed: null };
  } catch (error) {
    const committed = getCommittedWrite(error);
    if (committed) return { namespace, consumerId, committed };
    if (isUnobservedWrite(error)) {
      const queryKey = ["consumer", namespace, consumerId];
      const revision = qc.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
      await refreshConsumer(qc, namespace, consumerId);
      throw new UnobservedCredentialWriteError(revision);
    }
    // eslint-disable-next-line preserve-caught-error -- the cause is the secret-bearing error
    if (failure !== undefined) throw new Error(failure);
    // eslint-disable-next-line preserve-caught-error -- the cause is the secret-bearing error
    if (!(error instanceof Error)) throw new Error("Credential write failed");
    const forms = redactionForms(submittedValues(submitted));
    const detail = await redactedErrorDetail(error, forms);
    const message = redactSubmitted(error.message, forms);
    // eslint-disable-next-line preserve-caught-error -- the cause is the secret-bearing error
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
}

export function useUpdateCredentials() {
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
      data: ConsumerCredentialInput | ConsumerCredentialInput[];
    }) =>
      // Never surface an echoed response body: it may contain the password.
      writeCredential(
        qc,
        scope.namespace,
        consumerId,
        data,
        () => consumers.updateCredentials(scope, consumerId, credType, data),
        "Credential replacement failed. Check the gateway state before retrying.",
      ),
    onSuccess: ({ namespace, consumerId }) => refreshConsumer(qc, namespace, consumerId),
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
    }) =>
      writeCredential(qc, scope.namespace, consumerId, data, () =>
        consumers.appendCredential(scope, consumerId, credType, data),
      ),
    onSuccess: ({ namespace, consumerId }) => refreshConsumer(qc, namespace, consumerId),
  });
}

export function useDeleteCredentials() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      consumerId,
      credType,
    }: {
      consumerId: string;
      credType: string;
    }) =>
      writeCredential(qc, scope.namespace, consumerId, null, () =>
        consumers.deleteCredentials(scope, consumerId, credType),
      ),
    onSuccess: ({ namespace, consumerId }) => refreshConsumer(qc, namespace, consumerId),
  });
}

export function useDeleteCredentialByIndex() {
  const qc = useQueryClient();
  const { scope } = useNamespace();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      consumerId,
      credType,
      index,
    }: {
      consumerId: string;
      credType: string;
      index: number;
    }) =>
      writeCredential(qc, scope.namespace, consumerId, null, () =>
        consumers.deleteCredentialByIndex(scope, consumerId, credType, index),
      ),
    onSuccess: ({ namespace, consumerId }) => refreshConsumer(qc, namespace, consumerId),
  });
}
