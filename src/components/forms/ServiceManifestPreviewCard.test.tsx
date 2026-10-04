import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServiceManifestPreviewCard } from './ServiceManifestPreviewCard';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
let namespace = 'tenant-a';
vi.mock('@/api/serviceManifest', () => ({ previewServiceManifest: preview }));
vi.mock('@/stores/namespace', () => ({
  useNamespace: () => ({ scope: { namespace } }),
}));

const result = {
  readOnly: true,
  summary: { service: 'orders', namespace: 'tenant-a', authMode: 'gateway' },
  desired: { proxy: { id: 'orders', backend_scheme: 'http' }, upstream: null, plugin_configs: [] },
  warnings: ['Preview only. No policy is installed.', 'TLS paths are metadata, never read.'],
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preview.mockReset();
  preview.mockResolvedValue(result);
  namespace = 'tenant-a';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<ServiceManifestPreviewCard />));
}

async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', {
      bubbles: true, cancelable: true,
    }));
  });
}

it('provides a labelled preview input and a readable result without an apply action', async () => {
  await render();
  const label = host.querySelector('label')!;
  const input = host.querySelector('textarea')!;
  expect(label.textContent).toBe('Service manifest JSON');
  expect(label.htmlFor).toBe(input.id);
  expect(document.getElementById(input.getAttribute('aria-describedby')!)).not.toBeNull();
  expect(host.textContent).toContain('Viewers and editors');
  await fill('{"schema":"ferrum.service_manifest"}');
  await submit();
  expect(preview).toHaveBeenCalledWith(
    { namespace: 'tenant-a' }, '{"schema":"ferrum.service_manifest"}', expect.any(AbortSignal),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain('No gateway changes');
  expect(host.querySelector('pre')?.getAttribute('aria-label'))
    .toBe('Desired configuration and summary');
  expect(host.querySelector('pre')?.tabIndex).toBe(0);
  expect(host.querySelector('pre')?.textContent).toContain('backend_scheme');
  expect(input.value).toBe('');
  expect(Array.from(host.querySelectorAll('button')).map((button) => button.textContent))
    .toEqual(['Preview manifest', 'Clear preview']);
});

it('reports refusal accessibly and removes an old preview when the input changes', async () => {
  await render();
  await fill('{}');
  await submit();
  expect(host.querySelector('pre')).not.toBeNull();
  await fill('{"unknown":true}');
  expect(host.querySelector('pre')).toBeNull();
  preview.mockRejectedValue(new Error('Preview denied. Check namespace access.'));
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Preview denied');
  expect(host.querySelector('textarea')!.value).toBe('{"unknown":true}');
  expect(host.querySelector('pre')).toBeNull();
});

it('clears namespace-bound drafts, aborts old requests and discards late answers', async () => {
  let resolve!: (value: typeof result) => void;
  preview.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await render();
  await fill('{"draft":"old-tenant"}');
  await submit();
  const signal = preview.mock.calls[0][2] as AbortSignal;
  namespace = 'tenant-b';
  await render();
  expect(signal.aborted).toBe(true);
  expect(host.querySelector('textarea')!.value).toBe('');
  expect(host.textContent).toContain('tenant-b');
  await act(async () => resolve(result));
  expect(host.querySelector('pre')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
