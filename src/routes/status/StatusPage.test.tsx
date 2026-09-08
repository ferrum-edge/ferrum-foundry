import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { getHealth } from '@/api/metrics';
import { reportDeferredQueryError, setApiErrorHandler } from '@/api/client';
import type { HealthResponse } from '@/api/types';
import StatusPage from './index';

vi.mock('@/stores/namespace', () => ({
  useNamespace: () => ({ scope: { namespace: 'ferrum' } }),
}));
vi.mock('@/components/shared/BffConnectionCard', () => ({
  BffConnectionCard: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const fetcher = vi.fn();
const report = vi.fn();

beforeEach(() => {
  fetcher.mockReset();
  report.mockReset();
  vi.stubGlobal('Request', BasedRequest);
  vi.stubGlobal('fetch', fetcher);
  setApiErrorHandler(report);
  client = new QueryClient({
    queryCache: new QueryCache({ onError: reportDeferredQueryError }),
    defaultOptions: { queries: { retry: false } },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
});

async function renderUntil(text: string) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><StatusPage /></QueryClientProvider>);
  });
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain(text);
  });
}

describe('health snapshots', () => {
  it('models the upstream health status enum', () => {
    expectTypeOf<HealthResponse['status']>().toEqualTypeOf<
      'ok' | 'degraded' | 'starting' | 'unavailable' | 'draining'
    >();
  });

  it.each(['starting', 'unavailable', 'draining', 'degraded'] as const)(
    'renders a 503 %s snapshot without retrying or reporting an API error',
    async (status) => {
      fetcher.mockResolvedValue(Response.json({ status, ready: false }, { status: 503 }));
      await renderUntil(status.toUpperCase());
      expect(host.textContent).toContain('Not Ready');
      expect(host.textContent).not.toContain('Failed to fetch health status');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each(['ok', 'degraded'] as const)('renders a 200 %s snapshot', async (status) => {
    fetcher.mockResolvedValue(Response.json({ status, ready: true }));
    await renderUntil(status.toUpperCase());
    expect(report).not.toHaveBeenCalled();
  });

  it('renders the failure card for a transport failure', async () => {
    fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderUntil('Failed to fetch health status');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, 'not JSON'],
    [503, '{"error":"unavailable"}'],
    [503, '{"status":"draining","ready":"false"}'],
    [500, '{"status":"degraded","ready":false}'],
  ] as const)('rejects and reports an invalid %s response once (%#)', async (status, body) => {
    fetcher.mockResolvedValue(new Response(body, { status }));
    await expect(getHealth({ namespace: 'ferrum' })).rejects.toThrow('without a valid snapshot');
    expect(report).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
