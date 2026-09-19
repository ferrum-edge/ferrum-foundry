import { act } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, click, page, settle, stubFetch } from '@/test/__tests__/harness';
import { detailedHealth } from '@/test/__tests__/healthFixtures';
import { CapabilityProvider } from '@/stores/capabilities';
import type { GatewayRole } from '@/lib/capabilities';
import ProxyDetailPage from './$proxyId';
import ApiSpecsPage from '../api-specs';

let namespace: string;
let role: GatewayRole;
vi.mock('@/stores/namespace', () => ({ useNamespace: () => ({ selectedNamespace: namespace, scope: { namespace } }) }));
vi.mock('@/stores/auth', () => ({ useAuth: () => ({ principal: { role } }) }));
let harness: ReturnType<typeof createHarness>;
let requests: Request[];
let bindingStatus: number;
let noBinding: boolean;
let pendingA: boolean;
let finishA: (response: Response) => void;
let pendingDocument: boolean;
let documentMissing: boolean;
let finishDocument: (response: Response) => void;

const proxy = {
  id: 'shared', name: 'Orders proxy', listen_path: '/orders', backend_scheme: 'http',
  backend_host: 'localhost', backend_port: 8080, hosts: [], strip_listen_path: false,
  preserve_host_header: false, backend_connect_timeout_ms: 5000,
  backend_read_timeout_ms: 5000, backend_write_timeout_ms: 5000,
  backend_tls_verify_server_cert: true, auth_mode: 'single', frontend_tls: false,
  passthrough: false, udp_idle_timeout_seconds: 60, allowed_ws_origins: [],
  response_body_mode: 'stream', plugins: [], created_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-19T12:00:00Z',
};
const summary = (ns: string) => ({ id: `spec-${ns}`, proxy_id: 'shared', title: `API ${ns}`,
  spec_version: '3.1.0', spec_format: 'yaml', info_version: '1', tags: [], server_urls: [],
  operation_count: 2, uncompressed_size: 100, content_hash: 'hash',
  created_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-19T12:00:00Z' });
const bindings = (ns: string) => ({ items: [summary(ns)], total: 1, limit: 2, offset: 0, next_offset: null });

beforeEach(() => {
  namespace = 'tenant-a'; role = 'admin'; requests = []; bindingStatus = 200; noBinding = false;
  pendingA = false; pendingDocument = false; documentMissing = false; finishA = () => {}; finishDocument = () => {};
  harness = createHarness();
  stubFetch(request => {
    requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/proxy/', '');
    const ns = request.headers.get('X-Ferrum-Namespace')!;
    if (path === 'health') return Response.json(detailedHealth);
    if (path === 'proxies/shared') return Response.json(proxy);
    if (path === 'api-specs') {
      if (pendingA && ns === 'tenant-a') return new Promise<Response>(resolve => { finishA = resolve; });
      if (bindingStatus !== 200) return Response.json({ error: 'Unavailable' }, { status: bindingStatus });
      return Response.json(noBinding ? { items: [], total: 0, limit: 2, offset: 0, next_offset: null } : bindings(ns));
    }
    if (path === 'api-specs/by-proxy/shared') {
      if (documentMissing) return Response.json({ error: 'API spec not found' }, { status: 404 });
      if (pendingDocument && ns === 'tenant-a') return new Promise<Response>(resolve => { finishDocument = resolve; });
      return new Response(`openapi: 3.1.0\n# document ${ns}`, { headers: { 'content-type': 'application/yaml' } });
    }
    return Response.json(page([]));
  });
});
afterEach(async () => { await harness.dispose(); vi.unstubAllGlobals(); });

async function mount() {
  const parent = createRootRoute();
  const proxyRoute = createRoute({ getParentRoute: () => parent, path: '/proxies/$proxyId', component: ProxyDetailPage });
  const specRoute = createRoute({ getParentRoute: () => parent, path: '/api-specs', component: ApiSpecsPage });
  const router = createRouter({ routeTree: parent.addChildren([proxyRoute, specRoute]), history: createMemoryHistory({ initialEntries: ['/proxies/shared'] }) });
  await act(async () => { await router.load(); });
  const render = () => harness.render(<CapabilityProvider><RouterProvider router={router} /></CapabilityProvider>);
  await render();
  await settle(() => expect(harness.host.textContent).toContain('Orders proxy'));
  return { router, render };
}

describe('proxy bound-spec visibility', () => {
  it('shows the real spec UUID and navigates to its filtered API Specs list', async () => {
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('API tenant-a'));
    const link = [...harness.host.querySelectorAll('a')].find(a => a.textContent === 'API tenant-a')!;
    expect(link.getAttribute('href')).toContain('/api-specs?');
    expect(link.getAttribute('href')).toContain('spec-tenant-a');
    expect(link.getAttribute('href')).not.toContain('spec=shared');
    await act(async () => link.click());
    await settle(() => expect(harness.host.querySelector('h1')?.textContent).toBe('API Specs'));
    expect(harness.host.querySelector<HTMLInputElement>('input')?.value).toBe('spec-tenant-a');
    expect(harness.host.textContent).toContain('API tenant-a');
  });

  it('reads the bound raw document under the captured namespace without changing the editor', async () => {
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('View bound document'));
    await click('View bound document');
    await settle(() => expect(harness.host.textContent).toContain('# document tenant-a'));
    const read = requests.find(r => new URL(r.url).pathname.endsWith('/by-proxy/shared'))!;
    expect(read.headers.get('accept')).toBe('application/yaml');
    expect(read.headers.get('X-Ferrum-Namespace')).toBe('tenant-a');
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(harness.host.textContent).toContain('Config');
  });

  it('explains a binding removed between the summary and document reads', async () => {
    documentMissing = true;
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('View bound document'));
    await click('View bound document');
    await settle(() => expect(harness.host.textContent).toContain('No spec is now bound'));
    expect(harness.host.textContent).not.toContain('Bound spec document unavailable');
  });

  it('offers readable summaries while explaining the admin-only raw document for viewers', async () => {
    role = 'viewer';
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('API tenant-a'));
    expect(harness.host.textContent).toContain('admin role is required');
    expect(harness.host.textContent).not.toContain('View bound document');
    expect(requests.some(r => r.url.includes('/by-proxy/'))).toBe(false);
  });

  it('distinguishes a successful empty list from a failed summary read', async () => {
    noBinding = true;
    await mount();
    await settle(() => expect(harness.host.textContent).toContain('No API spec is bound'));
    bindingStatus = 503;
    await act(async () => { await harness.client.refetchQueries({ queryKey: ['apiSpecs'] }); });
    await settle(() => expect(harness.host.textContent).toContain('API spec bindings could not refresh'));
    expect(harness.host.textContent).not.toContain('No API spec is bound');
  });

  it('does not render a late metadata response from the old namespace', async () => {
    pendingA = true;
    const { render } = await mount();
    await settle(() => expect(requests.some(r => new URL(r.url).pathname.endsWith('/api-specs'))).toBe(true));
    expect(harness.host.textContent).not.toContain('No API spec is bound');
    namespace = 'tenant-b';
    await render();
    await settle(() => expect(harness.host.textContent).toContain('API tenant-b'));
    await act(async () => finishA(Response.json(bindings('tenant-a'))));
    await settle(() => expect(harness.client.getQueryData(['apiSpecs', 'tenant-a', 'byProxy', 'shared'])).toBeDefined());
    expect(harness.host.textContent).not.toContain('API tenant-a');
  });

  it('retires the document view on an editor identity switch', async () => {
    pendingDocument = true;
    const { render } = await mount();
    await settle(() => expect(harness.host.textContent).toContain('View bound document'));
    await click('View bound document');
    await settle(() => expect(requests.some(r => r.url.includes('/by-proxy/'))).toBe(true));
    namespace = 'tenant-b';
    await render();
    await settle(() => expect(harness.host.textContent).toContain('API tenant-b'));
    await act(async () => finishDocument(new Response('old namespace document', { headers: { 'content-type': 'application/yaml' } })));
    await settle(() => expect(harness.client.getQueryData(['apiSpecDocument', 'tenant-a', 'byProxy', 'shared'])).toBeDefined());
    expect(harness.host.textContent).not.toContain('old namespace document');
    expect(harness.host.textContent).toContain('View bound document');
  });
});
