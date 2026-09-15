import { describe, expect, it } from 'vitest';
import { MutationOutcomeUnknownError, observeMutation } from './mutationOutcome';

describe('mutation outcome classification', () => {
  it('preserves a successful observation', async () => {
    const result = { id: 'created' };
    await expect(observeMutation('Import', Promise.resolve(result))).resolves.toBe(result);
  });

  it.each([408, 500, 502, 504])('treats an unqualified HTTP %s as unknown', async (status) => {
    const error = Object.assign(new Error('interrupted'), { response: new Response(null, { status }) });
    await expect(observeMutation('Import', Promise.reject(error)))
      .rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it('treats a lost connection as unknown', async () => {
    await expect(observeMutation('Import', Promise.reject(new TypeError('Failed to fetch'))))
      .rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it.each([400, 401, 403, 409, 413, 429])('preserves a definite HTTP %s rejection', async (status) => {
    const error = Object.assign(new Error('rejected'), { response: new Response(null, { status }) });
    await expect(observeMutation('Import', Promise.reject(error))).rejects.toBe(error);
  });
});
