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
