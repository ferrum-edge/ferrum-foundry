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

it.each([400, 401, 403, 413, 415, 500])('reports safe %s failure without a popup', async (status) => {
  const secret = 'preview-secret-canary-123456789';
  respond.mockReturnValue(Response.json({ error: secret }, { status }));
  const failure = await previewServiceManifest({ namespace: 'tenant-a' }, secret)
    .catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).not.toContain(secret);
  expect(failure).not.toHaveProperty('request');
  expect(failure).not.toHaveProperty('cause');
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
