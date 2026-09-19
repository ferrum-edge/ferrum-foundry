import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, settle, stubFetch } from '@/test/__tests__/harness';
import { RuntimeTab } from './RuntimeTab';

let namespace: string;
vi.mock('@/stores/namespace', () => ({ useNamespace: () => ({ scope: { namespace } }) }));
let harness: ReturnType<typeof createHarness>;
const overlay = (version = 'accepted-v1') => ({ namespace: 'serving-namespace', version, runtime_overlay: { fields: {
  'ferrum.log.level': { kind: 'string', value: 'warn' },
  'ferrum.request_transformer.demo.enabled': { kind: 'bool', value: false },
  'ferrum.fault_injection.demo.abort_percent': { kind: 'fractional_percent', value: { numerator: 25, denominator: 'hundred' } },
} } });
beforeEach(() => { namespace = 'tenant-a'; harness = createHarness(); });
afterEach(async () => { await harness.dispose(); vi.unstubAllGlobals(); });

describe('runtime overlay observations', () => {
  it('renders typed fields, accepted version, and actual slice namespace for the connected node', async () => {
    stubFetch(() => Response.json(overlay()));
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain('accepted-v1'));
    for (const text of ['connected node', 'serving-namespace', 'warn', 'false', '25 / 100 (25%)']) expect(harness.host.textContent).toContain(text);
  });

  it.each([{}, { fields: {} }])('labels an accepted empty overlay (%#)', async runtime_overlay => {
    stubFetch(() => Response.json({ namespace: 'a', version: 'v', runtime_overlay }));
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain('accepted slice has no runtime fields'));
    expect(harness.host.textContent).not.toContain('No active overlay');
  });

  it.each([
    [404, 'No active mesh runtime overlay', 'No active overlay'],
    [503, 'Service unavailable', 'Temporarily unavailable'],
    [403, 'Forbidden', 'Access to runtime state was denied'],
    [401, 'Unauthorized', 'Access to runtime state was denied'],
    [404, 'Wrong route', 'Runtime overlay unavailable'],
  ])('distinguishes HTTP %s (%#)', async (status, error, expected) => {
    stubFetch(() => Response.json({ error }, { status }));
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain(expected));
    expect(harness.host.textContent).not.toContain('accepted slice has no runtime fields');
  });

  it.each(['network', 'invalid'])('does not present %s failure as absence', async kind => {
    stubFetch(() => { if (kind === 'network') throw new TypeError('offline'); return Response.json({ nodes: [] }); });
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain('Runtime overlay unavailable'));
    expect(harness.host.textContent).not.toContain('No active overlay');
  });

  it('withdraws stale values after a failed refresh', async () => {
    let failed = false;
    stubFetch(() => failed ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(overlay()));
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain('accepted-v1'));
    failed = true;
    await act(async () => { await harness.client.refetchQueries({ queryKey: ['mesh', 'runtimeOverlay'] }); });
    await settle(() => expect(harness.host.textContent).toContain('previous overlay is stale'));
    expect(harness.host.textContent).not.toContain('accepted-v1');
  });

  it('isolates late responses and cache keys across namespace authorization contexts', async () => {
    let finishA: (response: Response) => void = () => {};
    const requests: Request[] = [];
    stubFetch(request => {
      requests.push(request);
      return request.headers.get('X-Ferrum-Namespace') === 'tenant-a'
        ? new Promise<Response>(resolve => { finishA = resolve; }) : Response.json(overlay('tenant-b-version'));
    });
    await harness.render(<RuntimeTab />);
    await settle(() => expect(requests).toHaveLength(1));
    expect(harness.host.textContent).not.toContain('no runtime fields');
    namespace = 'tenant-b';
    await harness.render(<RuntimeTab />);
    await settle(() => expect(harness.host.textContent).toContain('tenant-b-version'));
    await act(async () => finishA(Response.json(overlay('tenant-a-version'))));
    await settle(() => expect(harness.client.getQueryData(['mesh', 'runtimeOverlay', 'tenant-a'])).toBeDefined());
    expect(harness.host.textContent).not.toContain('tenant-a-version');
    expect(harness.client.getQueryData(['mesh', 'runtimeOverlay', 'tenant-b'])).toBeDefined();
  });
});
