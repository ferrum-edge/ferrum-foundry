import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubFetch } from '@/test/__tests__/harness';
import { setApiErrorHandler, setCsrfToken } from './client';
import { previewServiceManifest } from './serviceManifest';

let requests: Request[];
const popup = vi.fn();
const respond = vi.fn<(request: Request) => Response>();

beforeEach(() => {
  requests = [];
  respond.mockReset();
  popup.mockClear();
  setCsrfToken('csrf-for-preview');
  setApiErrorHandler(popup);
  stubFetch((request) => {
    requests.push(request);
    return respond(request);
  });
});

afterEach(() => {
  setCsrfToken(null);
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('uses the authenticated BFF and captured scope without storing the document', async () => {
  const raw = '{"schema":"ferrum.service_manifest"}';
  respond.mockReturnValue(Response.json({ readOnly: true }));
  localStorage.setItem('ferrum:namespace', 'different-tenant');
  await previewServiceManifest({ namespace: 'tenant-a' }, raw);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).pathname).toBe('/api/service-manifest/preview');
  expect(requests[0].method).toBe('POST');
  expect(requests[0].headers.get('X-Ferrum-Namespace')).toBe('tenant-a');
  expect(requests[0].headers.get('X-CSRF-Token')).toBe('csrf-for-preview');
  expect(requests[0].headers.get('content-type')).toBe('application/json');
  expect(await requests[0].text()).toBe(raw);
  expect(localStorage.length).toBe(1);
  expect(popup).not.toHaveBeenCalled();
});

it.each([
  [400, 'Use supported v1 manifest JSON in the active namespace, within preview limits.'],
  [401, 'Sign in to preview a service manifest.'],
  [403, 'Preview denied. Check session, CSRF and namespace access.'],
  [413, 'Manifest exceeds the 32 KiB preview budget.'],
  [415, 'Use supported v1 manifest JSON in the active namespace, within preview limits.'],
  [500, 'Preview unavailable. No configuration was applied; retry to obtain a preview.'],
] as const)(
  'reports safe %s failure without retaining response data or a popup', async (status, message) => {
    const secret = 'preview-secret-canary-123456789';
    const unknownKey = 'unreviewed-credential-field';
    const document = JSON.stringify({ [unknownKey]: { password: secret } });
    respond.mockReturnValue(Response.json({
      error: secret, data: { [unknownKey]: secret }, cause: { message: secret },
    }, { status }));
    const failure: unknown = await previewServiceManifest({ namespace: 'tenant-a' }, document)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected a detached preview error');
    expect(failure.message).toBe(message);
    for (const field of ['request', 'options', 'response', 'data', 'body', 'cause']) {
      expect(failure).not.toHaveProperty(field);
    }
    expect(Object.getOwnPropertyNames(failure).sort()).toEqual(['message', 'stack']);
    expect(failure.stack).not.toContain(secret);
    expect(failure.stack).not.toContain(unknownKey);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(popup).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  },
);

it('detaches a non-HTTP failure containing the document, request and nested raw causes', async () => {
  const secret = 'preview-transport-secret-123456789';
  const unknownKey = 'unknown-transport-credential';
  const document = JSON.stringify({ [unknownKey]: secret });
  const original = Object.assign(new TypeError(secret), {
    cause: new Error(document), data: { [unknownKey]: secret }, options: { body: document },
  });
  respond.mockImplementation((request) => {
    throw Object.assign(original, { request });
  });
  const failure: unknown = await previewServiceManifest({ namespace: 'tenant-a' }, document)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected a detached preview error');
  expect(failure).not.toBe(original);
  expect(failure.message).toBe(
    'Preview unavailable. No configuration was applied; retry to obtain a preview.',
  );
  expect(Object.getOwnPropertyNames(failure).sort()).toEqual(['message', 'stack']);
  expect(failure.stack).not.toContain(secret);
  expect(failure.stack).not.toContain(unknownKey);
  expect(popup).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
});

it('refuses oversized UTF-8 before sending, and passes cancellation to the request', async () => {
  await expect(previewServiceManifest({ namespace: 'tenant-a' }, 'é'.repeat(17 * 1024)))
    .rejects.toThrow('32 KiB');
  expect(requests).toHaveLength(0);
  const controller = new AbortController();
  controller.abort();
  await expect(previewServiceManifest({ namespace: 'tenant-a' }, '{}', controller.signal))
    .rejects.toThrow('No configuration was applied');
});
