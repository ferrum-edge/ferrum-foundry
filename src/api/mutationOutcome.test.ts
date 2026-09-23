import { describe, expect, it } from 'vitest';
import {
  classifyUnobservedOutcome,
  MutationOutcomeUnknownError,
  observeMutation,
} from './mutationOutcome';

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

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status }, data });
}

describe('classifyUnobservedOutcome', () => {
  const unobservable: Array<[number, Record<string, unknown> & { error: string }, string]> = [
    [504, { error: 'Gateway Timeout', code: 'FERRUM_BFF_TIMEOUT', phase: 'response' }, 'gateway_timeout'],
    [504, { error: 'Gateway Timeout' }, 'gateway_timeout'],
    [502, { error: 'Bad Gateway', code: 'FERRUM_BFF_UPSTREAM_FAILURE' }, 'upstream_failure'],
  ];

  it.each(unobservable)('treats %d as unobservable', (status, data, reason) => {
    expect(classifyUnobservedOutcome(httpError(status, data))).toEqual({
      reason,
      detail: data.error,
    });
  });

  it('keeps an upload-phase timeout a definite, retryable failure', () => {
    const error = httpError(504, {
      error: 'Gateway Timeout', code: 'FERRUM_BFF_TIMEOUT', phase: 'upload', reason: 'idle',
    });
    expect(classifyUnobservedOutcome(error)).toBeNull();
  });

  it('classifies a client timeout and a dropped connection', () => {
    const timeout = Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
    expect(classifyUnobservedOutcome(timeout)).toEqual({ reason: 'client_timeout', detail: null });
    expect(classifyUnobservedOutcome(new TypeError('Failed to fetch'))).toEqual({
      reason: 'transport',
      detail: 'Failed to fetch',
    });
  });

  it('leaves gateway answers and pre-send refusals to their own classifiers', () => {
    const unbound = Object.assign(new Error('no namespace binding'), {
      name: 'UnboundNamespaceError',
    });
    expect(classifyUnobservedOutcome(unbound)).toBeNull();
    expect(classifyUnobservedOutcome(httpError(500, { error: 'restore failed' }))).toBeNull();
    expect(classifyUnobservedOutcome(httpError(503, { error: 'database unreachable' }))).toBeNull();
    expect(classifyUnobservedOutcome(httpError(409, { error: 'specs at risk' }))).toBeNull();
    expect(classifyUnobservedOutcome('not an error')).toBeNull();
  });
});
