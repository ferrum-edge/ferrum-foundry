/** A lost response cannot establish whether a remote mutation committed. */
export class MutationOutcomeUnknownError extends Error {
  constructor(operation: string, cause: unknown) {
    super(
      `${operation} outcome unknown. Check the remote resources before retrying; ` +
        'do not repeat this operation blindly.',
      { cause },
    );
    this.name = 'MutationOutcomeUnknownError';
  }
}

export async function observeMutation<T>(operation: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    const status =
      error instanceof Error && 'response' in error
        ? (error as { response: Response }).response.status
        : undefined;
    const data = error instanceof Error && 'data' in error ? error.data : undefined;
    // A BFF upload timeout proves the complete document never reached admission.
    // Bare 504s and response-phase timeouts do not provide that guarantee.
    const uploadRejected =
      status === 504 &&
      data !== null &&
      typeof data === 'object' &&
      'code' in data &&
      data.code === 'FERRUM_BFF_TIMEOUT' &&
      'phase' in data &&
      data.phase === 'upload';
    if (!uploadRejected && (status === undefined || status === 408 || status >= 500)) {
      throw new MutationOutcomeUnknownError(operation, error);
    }
    throw error;
  }
}

export type UnobservedOutcomeReason =
  | 'gateway_timeout'
  | 'upstream_failure'
  | 'client_timeout'
  | 'transport';

export interface UnobservedOutcome {
  reason: UnobservedOutcomeReason;
  detail: string | null;
}

/** Operator-facing cause for each reason; says what was lost, never what happened. */
export const UNOBSERVED_OUTCOME_CAUSE: Record<UnobservedOutcomeReason, string> = {
  gateway_timeout: 'No answer arrived before the time limit once the request was on its way.',
  upstream_failure: "The BFF's connection to the gateway failed before an answer arrived.",
  client_timeout: "Foundry stopped waiting for the gateway's answer.",
  transport: 'The request ended without an answer.',
};

function bffErrorBody(candidate: { data?: unknown }): Record<string, unknown> | undefined {
  return candidate.data && typeof candidate.data === 'object'
    ? (candidate.data as Record<string, unknown>)
    : undefined;
}

/**
 * Classify a write failure Foundry could not observe the outcome of. Restore
 * and every ordinary create/update/delete share this one classifier.
 *
 * The gateway's own answers say what happened; these do not. The BFF's
 * `phase` is the discriminator and the only proof available: `'upload'` means
 * the request body never finished streaming, so the write provably did not
 * run. Every other transport outcome — a `504` once the body has been sent, a
 * `502` `FERRUM_BFF_UPSTREAM_FAILURE`, ky's own `TimeoutError`, a dropped
 * connection — leaves a write that may already have committed on the gateway.
 * The admin API offers no operation id or idempotency key, so nothing can
 * resolve that automatically; the honest report is "outcome unknown, read the
 * gateway back". The write is never replayed to find out.
 *
 * The non-HTTP branch is deliberately fail-safe: an unrecognized rejection
 * from a request that was already issued is treated as unobservable rather
 * than as a definite failure. `UnboundNamespaceError` is the one exclusion —
 * the client raises it before a byte goes on the wire.
 */
export function classifyUnobservedOutcome(error: unknown): UnobservedOutcome | null {
  if (!(error instanceof Error)) return null;
  if (error.name === 'UnboundNamespaceError') return null;

  const candidate = error as { response?: { status?: unknown }; data?: unknown };
  const status = candidate.response?.status;
  if (typeof status !== 'number') {
    if (error.name === 'TimeoutError') return { reason: 'client_timeout', detail: null };
    return { reason: 'transport', detail: error.message || null };
  }

  const body = bffErrorBody(candidate);
  const detail = typeof body?.error === 'string' ? body.error : null;
  if (status === 504) {
    // Only the BFF's own upload phase proves the body never landed.
    if (body?.phase === 'upload') return null;
    return { reason: 'gateway_timeout', detail };
  }
  if (status === 502) return { reason: 'upstream_failure', detail };
  return null;
}
