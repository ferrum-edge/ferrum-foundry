import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, fill, settle, stubFetch } from '@/test/__tests__/harness';
import { auditPipeline, detailedHealth } from '@/test/__tests__/healthFixtures';
import AuditPage from './index';

let namespace: string;
vi.mock('@/stores/namespace', () => ({ useNamespace: () => ({ scope: { namespace } }) }));
let harness: ReturnType<typeof createHarness>;
let health: unknown;
let healthFailure: boolean;
let requests: Request[];
let auditPages: ((request: Request) => Response) | null;
beforeEach(() => {
  namespace = 'tenant-a'; health = detailedHealth; healthFailure = false; requests = []; auditPages = null;
  harness = createHarness();
  stubFetch(request => {
    requests.push(request);
    if (new URL(request.url).pathname.endsWith('/health')) {
      if (healthFailure) throw new TypeError('offline');
      return Response.json(health);
    }
    if (auditPages) return auditPages(request);
    return Response.json({ items: [], total: 0, limit: 50, offset: 0, next_offset: null });
  });
});
afterEach(async () => { await harness.dispose(); vi.unstubAllGlobals(); });

async function mount() {
  await harness.render(<AuditPage />);
  await settle(() => expect(harness.host.textContent).toContain('No audit events'));
}

describe('audit evidence and collection state', () => {
  it('names the disabled-by-default setting only after a detailed read', async () => {
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('Collection disabled'));
    expect(harness.host.textContent).toContain('FERRUM_ADMIN_AUDIT_ENABLED');
    expect(harness.host.textContent).not.toContain('mutations will appear here');
  });

  it.each([
    ['minimal', { status: 'ok', ready: true }],
    ['partial', { status: 'ok', ready: true, mode: 'database' }],
    ['null pipeline', { ...detailedHealth, audit_pipeline: null }],
  ])('keeps collection unknown for a %s response', async (_label, snapshot) => {
    health = snapshot;
    await mount();
    expect(harness.host.textContent).toContain('collection status is unknown');
    expect(harness.host.textContent).not.toContain('Collection disabled');
  });

  it('distinguishes enabled empty collection and preserves scoped actor filters', async () => {
    health = { ...detailedHealth, audit_pipeline: auditPipeline };
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('Collection is enabled'));
    await fill(harness.host.querySelector('input')!, 'operator@example.test');
    await settle(() => expect(requests.some(r => new URL(r.url).searchParams.get('actor') === 'operator@example.test')).toBe(true));
    const request = requests.filter(r => new URL(r.url).pathname.endsWith('/audit')).at(-1)!;
    expect(new URL(request.url).searchParams.get('limit')).toBe('50');
    expect(new URL(request.url).searchParams.get('offset')).toBe('0');
    expect(request.headers.get('X-Ferrum-Namespace')).toBe('tenant-a');
  });

  it.each(['fail_open', 'fail_closed'] as const)('explains unavailable %s policy from real availability', async policy => {
    health = { ...detailedHealth, audit_pipeline: { ...auditPipeline, policy, available: false } };
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('Unavailable'));
    expect(harness.host.textContent).toContain('not proof that no mutations occurred');
    expect(harness.host.textContent).toContain(policy === 'fail_closed' ? 'HTTP 503 before they run' : 'without durable pre-mutation evidence');
  });

  it('keeps degraded/evidence-lost distinct from current fail-closed availability', async () => {
    health = { ...detailedHealth, audit_pipeline: { ...auditPipeline, degraded: true, evidence_lost: true } };
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('Evidence lost'));
    expect(harness.host.textContent).toContain('permanently discarded');
    expect(harness.host.textContent).not.toContain('HTTP 503 before they run');
  });

  it('withdraws the disabled conclusion after a failed refresh with retained data', async () => {
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('Collection disabled'));
    healthFailure = true;
    await act(async () => { await harness.client.refetchQueries({ queryKey: ['health'] }); });
    await settle(() => expect(harness.host.textContent).toContain('Health read failed'));
    expect(harness.host.textContent).toContain('collection status is unknown');
    expect(harness.host.textContent).not.toContain('Collection disabled');
  });

  it('does not use a late health response from another namespace', async () => {
    let finishA: (response: Response) => void = () => {};
    stubFetch(request => {
      if (new URL(request.url).pathname.endsWith('/health')) {
        if (request.headers.get('X-Ferrum-Namespace') === 'tenant-a') return new Promise<Response>(resolve => { finishA = resolve; });
        return Response.json({ ...detailedHealth, audit_pipeline: auditPipeline });
      }
      return Response.json({ items: [], total: 0, limit: 50, offset: 0, next_offset: null });
    });
    await mount();
    expect(harness.host.textContent).toContain('Loading health status');
    namespace = 'tenant-b';
    await harness.render(<AuditPage />);
    await settle(() => expect(harness.host.textContent).toContain('Collection is enabled'));
    await act(async () => finishA(Response.json(detailedHealth)));
    await settle(() => expect(harness.client.getQueryData(['health', 'tenant-a'])).toBeDefined());
    expect(harness.host.textContent).not.toContain('Collection disabled');
  });
});

describe('audit pagination across a namespace switch', () => {
  const event = (id: number) => ({
    id: `e${id}`, ts: '2026-09-20T00:00:00Z', actor: 'op', action: 'update',
    resource_type: 'proxy', resource_id: 'orders', namespace, outcome: 'success', diff: {},
  });
  const auditOffsets = () => requests
    .filter(r => new URL(r.url).pathname.endsWith('/audit'))
    .map(r => [r.headers.get('X-Ferrum-Namespace'), new URL(r.url).searchParams.get('offset')]);

  it('starts the new namespace at its first page', async () => {
    auditPages = (request) => {
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      const total = request.headers.get('X-Ferrum-Namespace') === 'tenant-a' ? 300 : 30;
      const items = offset < total ? Array.from({ length: Math.min(50, total - offset) }, (_, i) => event(offset + i)) : [];
      return Response.json({ items, total, limit: 50, offset, next_offset: offset + 50 < total ? offset + 50 : null });
    };
    await harness.render(<AuditPage />);
    await settle(() => expect(harness.host.textContent).toContain('1–50 of 300'));
    const next = [...harness.host.querySelectorAll('button')].find(b => b.textContent === 'Next')!;
    await act(async () => next.click());
    await settle(() => expect(harness.host.textContent).toContain('51–100 of 300'));

    namespace = 'tenant-b';
    await harness.render(<AuditPage />);
    await settle(() => expect(auditOffsets().at(-1)).toEqual(['tenant-b', '0']));
    expect(harness.host.textContent).not.toContain('No audit events');
  });

  it('offers a way back from a page past the end', async () => {
    auditPages = (request) => {
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      // The log shrank (retention) after the first page was read.
      return offset === 0
        ? Response.json({ items: [event(0)], total: 120, limit: 50, offset, next_offset: 50 })
        : Response.json({ items: [], total: 20, limit: 50, offset, next_offset: null });
    };
    await harness.render(<AuditPage />);
    await settle(() => expect(harness.host.textContent).toContain('of 120'));
    const next = [...harness.host.querySelectorAll('button')].find(b => b.textContent === 'Next')!;
    await act(async () => next.click());
    await settle(() => expect(harness.host.textContent).toContain('No results on this page'));
    expect(harness.host.textContent).not.toContain('No audit events');
    const back = [...harness.host.querySelectorAll('button')].find(b => b.textContent === 'Go to first page')!;
    await act(async () => back.click());
    await settle(() => expect(harness.host.textContent).toContain('of 120'));
  });
});
