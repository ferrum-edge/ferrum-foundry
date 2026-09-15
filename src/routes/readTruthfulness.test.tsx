import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type RouteComponent,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/stores/auth';
import { NamespaceProvider } from '@/stores/namespace';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import ProxyPage from './proxies/$proxyId';
import ConsumerPage from './consumers/$consumerId';
import PluginPage from './plugins/$pluginId';
import UpstreamPage from './upstreams/$upstreamId';
import DashboardPage from './dashboard';
import MeshPage from './mesh';
import AuditPage from './audit';
import ApiSpecsPage from './api-specs';

// All components, providers, hooks, query transitions, and ky are real. Only
// transport is controlled; no cache injection can manufacture an error state.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
  }
}

const stamp = '2026-09-08T00:00:00Z';
const proxy = {
  id: 'shared', name: 'Orders', listen_path: '/orders', backend_scheme: 'http',
  backend_host: 'localhost', backend_port: 8080, hosts: [], strip_listen_path: false,
  preserve_host_header: false, backend_connect_timeout_ms: 5000,
  backend_read_timeout_ms: 5000, backend_write_timeout_ms: 5000,
  backend_tls_verify_server_cert: true, auth_mode: 'single', frontend_tls: false,
  passthrough: false, udp_idle_timeout_seconds: 60, allowed_ws_origins: [],
  response_body_mode: 'stream', plugins: [], created_at: stamp, updated_at: stamp,
};
const consumer = {
  id: 'shared', username: 'Operator', credentials: {}, acl_groups: [],
  created_at: stamp, updated_at: stamp,
};
const plugin = {
  id: 'shared', plugin_name: 'rate_limiting', scope: 'proxy_group', config: {},
  enabled: true, created_at: stamp, updated_at: stamp,
};
const upstream = {
  id: 'shared', name: 'Origin', algorithm: 'round_robin', targets: [],
  created_at: stamp, updated_at: stamp,
};
function page(data: unknown[]) {
  return { data, pagination: { offset: 0, limit: 250, total: data.length } };
}
function items(data: unknown[]) {
  return { items: data, total: data.length, offset: 0, limit: 20, next_offset: null };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let responses: Map<string, unknown>;
let failures: Map<string, number>;
let writes: string[];

beforeEach(() => {
  localStorage.setItem('ferrum:namespace', 'tenant-a');
  localStorage.setItem('ferrum:metricsRefreshInterval', '0');
  failures = new Map();
  writes = [];
  responses = new Map<string, unknown>([
    ['proxies/shared', proxy], ['consumers/shared', consumer],
    ['plugins/config/shared', plugin], ['upstreams/shared', upstream],
    ['proxies', page([
      { ...proxy, name: null, plugins: [{ plugin_config_id: 'shared' }] },
      { ...proxy, name: null, id: 'destination', listen_path: '/destination',
        plugins: [{ plugin_config_id: 'shared' }] },
    ])],
    ['consumers', page([consumer])], ['plugins/config', page([])],
    ['upstreams', page([])], ['plugins', ['rate_limiting']],
    ['health', { status: 'ok', ready: true, mode: 'mesh' }],
    ['admin/metrics', {
      gateway: {
        proxy_count: 7, consumer_count: 2, upstream_count: 3, plugin_config_count: 4,
        uptime_seconds: 3600, ferrum_version: 'fixture-version', total_requests: 0,
        status_codes_total: {},
      },
      circuit_breakers: [{ proxy_id: 'historical-breaker', state: 'open', failure_count: 5 }],
      health_check: { unhealthy_targets: [{ target: 'historical-target', since_epoch_ms: 0 }] },
    }],
    ['mesh/remote-clusters', { discovery_enabled: true, configured: [], discovered: [] }],
    ['mesh/federation', { bundles: [{
      cluster: 'historical-federation', trust_domain: 'example.test',
      endpoint: 'https://example.test',
      x509_authorities: 1, jwt_authorities: 0, bundle_age_seconds: 10,
    }] }],
    ['node-waypoint/identities', { identity_count: 0, identities: [] }],
    ['service-waypoint/services', {
      waypoint_name: 'historical-waypoint', service_count: 0, services: [],
    }],
    ['gateway-trust-bundles', page([])],
    ['gateway-trust/status', {
      configured: true, authority_unresolved: false, generation: 'published-generation',
      bundle: { trust_domain: 'example.test', revision: 1 },
      process: { published_generations_total: 3, load_rejections_total: 0,
        last_failure_reason: 'none' },
    }],
    ['audit', items([{
      id: 'event', action: 'delete', resource_type: 'proxy', resource_id: 'historical-audit-row',
      actor: 'operator', outcome: 'success', ts: stamp, namespace: 'tenant-a', diff: {},
    }])],
    ['api-specs', items([{
      id: 'spec', title: 'Historical API', proxy_id: 'shared', tags: [], info_version: '1',
      spec_version: '3.1.0', operation_count: 1, uncompressed_size: 100, updated_at: stamp,
    }])],
  ]);
  vi.stubGlobal('Request', BasedRequest);
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET') writes.push(`${request.method} ${path}`);
    if (path === '/api/auth/config') return Response.json({ mode: 'static' });
    if (path === '/api/auth/session') return Response.json({
      principal: {
        subject: 'fixture', role: 'admin', authMode: 'static', namespaces: ['tenant-a'],
      },
      csrfToken: 'synthetic-csrf',
    });
    if (path === '/api/health/ready') return Response.json({
      status: 'ready', ready: true, checkedAt: stamp,
      components: { bff: { status: 'ok' }, gateway: { status: 'ok' } },
    });
    const endpoint = path.replace('/api/proxy/', '');
    if (failures.has(endpoint)) return new Response('Unavailable', {
      status: failures.get(endpoint), headers: { 'retry-after': '0' },
    });
    if (responses.has(endpoint)) return Response.json(responses.get(endpoint));
    return new Response('Not enabled', { status: 404 });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}
function Authenticated({ children }: { children: ReactNode }) {
  return useAuth().status === 'authenticated' ? children : null;
}
async function mount(Page: RouteComponent, path = '/view') {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path, component: Page });
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path.replace(/\$\w+/, 'shared')] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Authenticated>
            <NamespaceProvider>
              <ToastProvider>
                <TooltipProvider><RouterProvider router={router} /></TooltipProvider>
              </ToastProvider>
            </NamespaceProvider>
          </Authenticated>
        </AuthProvider>
      </QueryClientProvider>,
    );
  });
  await settle(() => expect(host.querySelector('h1')).not.toBeNull());
}
async function tab(prefix: string) {
  const target = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((entry) => entry.textContent?.startsWith(prefix))!;
  expect(target).toBeTruthy();
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
async function refetch(queryKey: QueryKey) {
  await act(async () => { await client.refetchQueries({ queryKey }); });
}
function field(label: string) {
  const named = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (named) return named;
  const id = [...host.querySelectorAll('label')]
    .find((entry) => entry.textContent === label)?.htmlFor;
  return document.getElementById(id ?? '') as HTMLInputElement;
}
async function edit(label: string, value: string) {
  const input = field(label);
  expect(input).toBeTruthy();
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(field(label).value).toBe(value);
  return input;
}

const editors = [
  { name: 'Proxy', Page: ProxyPage, path: '/proxies/$proxyId', endpoint: 'proxies/shared',
    key: 'proxy', field: 'Name' },
  { name: 'Consumer', Page: ConsumerPage, path: '/consumers/$consumerId',
    endpoint: 'consumers/shared',
    key: 'consumer', field: 'Username' },
  { name: 'Upstream', Page: UpstreamPage, path: '/upstreams/$upstreamId',
    endpoint: 'upstreams/shared',
    key: 'upstream', field: 'Name' },
  { name: 'Plugin', Page: PluginPage, path: '/plugins/$pluginId', endpoint: 'plugins/config/shared',
    key: 'pluginConfig', field: 'Plugin config JSON' },
];

describe('detail drafts survive terminal background errors (#299)', () => {
  it.each(editors)('$name preserves its mounted draft through failure and recovery', async (c) => {
    await mount(c.Page, c.path);
    await settle(() => expect(field(c.field)).toBeTruthy());
    const input = await edit(c.field, c.name === 'Plugin' ? '{"dirty":true}' : 'Unsaved draft');
    const value = input.value;
    const key = [c.key, 'tenant-a', 'shared'];
    failures.set(c.endpoint, 503);
    await refetch(key);
    await settle(() => {
      expect(host.textContent).toContain(`${c.name} configuration could not refresh`);
    });
    expect(client.getQueryState(key)?.status).toBe('error');
    expect(client.getQueryData(key)).toBeDefined();
    expect(field(c.field)).toBe(input);
    expect(input.value).toBe(value);
    failures.delete(c.endpoint);
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === `Retry ${c.name} configuration`)!;
    await act(async () => retry.click());
    await settle(() => expect(client.getQueryState(key)?.status).toBe('success'));
    expect(field(c.field)).toBe(input);
    expect(input.value).toBe(value);
  });

  it.each(editors)('$name keeps the initial no-data failure terminal', async (c) => {
    failures.set(c.endpoint, 503);
    // Initial errors have no heading, so render a wrapper heading for mount's readiness check.
    function Page() { return <><h1>Initial load</h1><c.Page /></>; }
    await mount(Page, c.path);
    await settle(() => {
      expect(host.textContent).toContain(`Failed to load ${c.name.toLowerCase()}`);
    });
    expect(host.querySelector('form')).toBeNull();
  });

  it('disables unavailable membership without resetting selections or config', async () => {
    await mount(PluginPage, '/plugins/$pluginId');
    const config = await edit('Plugin config JSON', '{"draft":123}');
    const toggles = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => { toggles[0]!.click(); toggles[1]!.click(); });
    const trigger = await edit('Execution trigger JSON', '{"match":{"method":"POST"}}');
    const scope = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')]
      .find((entry) => entry.textContent?.includes('Proxy Group'))!;
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove /orders"]')!;
    await act(async () => remove.click());
    failures.set('proxies', 503);
    await refetch(['proxies', 'tenant-a', 'all']);
    await settle(() => {
      expect(host.textContent).toContain('Proxy group membership could not refresh');
    });
    expect(field('Plugin config JSON')).toBe(config);
    expect(config.value).toBe('{"draft":123}');
    expect(field('Execution trigger JSON')).toBe(trigger);
    expect(trigger.value).toBe('{"match":{"method":"POST"}}');
    expect(toggles[0]!.checked).toBe(false);
    expect(toggles[1]!.checked).toBe(true);
    expect(scope.isConnected).toBe(true);
    const picker = host.querySelector<HTMLInputElement>(
      '[placeholder="Search proxies to add..."]',
    )!;
    expect(picker.disabled).toBe(true);
    const remaining = host.querySelector<HTMLButtonElement>('[aria-label="Remove /destination"]')!;
    expect(remaining.disabled).toBe(true);
    expect(host.querySelector('[aria-label="Remove /orders"]')).toBeNull();
    failures.delete('proxies');
    const retryCatalog = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry Proxy catalog')!;
    expect(retryCatalog.type).toBe('button');
    await act(async () => retryCatalog.click());
    await settle(() => expect(picker.disabled).toBe(false));
    expect(field('Plugin config JSON')).toBe(config);
    expect(config.value).toBe('{"draft":123}');
    expect(field('Execution trigger JSON')).toBe(trigger);
    expect(trigger.value).toBe('{"match":{"method":"POST"}}');
    expect(toggles[0]!.checked).toBe(false);
    expect(toggles[1]!.checked).toBe(true);
    expect(scope.isConnected).toBe(true);
    expect(host.querySelector('[aria-label="Remove /orders"]')).toBeNull();
    expect(remaining.disabled).toBe(false);
    expect(writes).toEqual([]);
  });
});

const surfaces = [
  { name: 'proxy policy', Page: ProxyPage, path: '/proxies/$proxyId', tab: 'Consumers',
    endpoint: 'plugins/config', key: ['pluginConfigs', 'tenant-a', 'all'],
    label: 'Authorized consumers', fact: 'No consumers are authorized for this proxy.' },
  { name: 'consumer policy', Page: ConsumerPage, path: '/consumers/$consumerId',
    tab: 'Matched Proxies',
    endpoint: 'plugins/config', key: ['pluginConfigs', 'tenant-a', 'all'],
    label: 'Authorized proxies',
    fact: 'No proxy is conclusively or conditionally matched for this consumer.' },
  { name: 'trust bundle', Page: MeshPage, tab: 'Trust', endpoint: 'gateway-trust-bundles',
    key: ['trustBundles', 'tenant-a'], label: 'SPIFFE trust bundle',
    fact: 'has no SPIFFE trust bundle' },
  { name: 'federation', Page: MeshPage, tab: 'Clusters', endpoint: 'mesh/federation',
    key: ['mesh', 'federation'], label: 'Federated trust bundles', fact: 'historical-federation' },
  { name: 'remote clusters', Page: MeshPage, tab: 'Clusters', endpoint: 'mesh/remote-clusters',
    key: ['mesh', 'remoteClusters'], label: 'Remote clusters', fact: 'No remote clusters' },
  { name: 'waypoints', Page: MeshPage, tab: 'Waypoints', endpoint: 'service-waypoint/services',
    key: ['mesh', 'serviceWaypointServices'],
    label: 'Service waypoint services', fact: 'historical-waypoint' },
  { name: 'dashboard', Page: DashboardPage, endpoint: 'admin/metrics',
    key: ['adminMetrics', 'tenant-a'], label: 'Admin metrics', fact: 'historical-breaker' },
  { name: 'audit', Page: AuditPage, endpoint: 'audit', key: ['audit', 'tenant-a'],
    label: 'Audit log', fact: 'historical-audit-row' },
  { name: 'API specs', Page: ApiSpecsPage, endpoint: 'api-specs', key: ['apiSpecs', 'tenant-a'],
    label: 'API specs', fact: 'Historical API' },
];

describe('read truthfulness on every reported surface (#298)', () => {
  for (const initial of [true, false]) {
    it.each(surfaces)(`$name refuses false facts (initial failure: ${initial})`, async (c) => {
      if (initial) failures.set(c.endpoint, 503);
      await mount(c.Page, c.path);
      if (c.tab) await tab(c.tab);
      if (!initial) {
        await settle(() => {
          expect(client.getQueriesData({ queryKey: c.key })[0]?.[1]).toBeDefined();
        });
        failures.set(c.endpoint, 503);
        await refetch(c.key);
      }
      await settle(() => expect(host.textContent).toContain(
        `${c.label} ${initial ? 'unavailable' : 'could not refresh'}`,
      ));
      expect(host.textContent).not.toContain(c.fact);
      expect(host.textContent).toContain('Current state is unknown');
      if (c.name === 'proxy policy') {
        await tab('Plugins');
        expect(host.textContent).not.toContain('No plugins run on this proxy');
        expect(host.textContent).toContain('Plugins (unknown)');
      }
      if (c.name === 'trust bundle') {
        expect(host.textContent).toContain('published-generation');
        expect(host.textContent).not.toContain('Create Trust Bundle');
      }
      if (c.name === 'API specs') {
        expect(host.querySelector('[aria-label="Delete spec Historical API"]')).toBeNull();
        const replace = [...host.querySelectorAll('button')]
          .some((button) => button.textContent === 'Replace');
        expect(replace).toBe(false);
      }
      expect(writes).toEqual([]);
      failures.delete(c.endpoint);
      await refetch(c.key);
      await settle(() => expect(host.textContent).not.toContain(`${c.label} could not refresh`));
      await settle(() => expect(host.textContent).not.toContain(`${c.label} unavailable`));
    });
  }

  it('hides failed process health and all failed metrics on the manual dashboard', async () => {
    await mount(DashboardPage);
    await settle(() => expect(host.textContent).toContain('historical-target'));
    failures.set('health', 503);
    failures.set('admin/metrics', 500);
    await refetch(['health']);
    await refetch(['adminMetrics']);
    await settle(() => {
      expect(host.textContent).toContain('Gateway process health could not refresh');
    });
    expect(host.textContent).not.toContain('historical-target');
    expect(host.textContent).not.toContain('fixture-version');
    expect(host.textContent).toContain('Admin metrics last updated');
    expect(host.textContent).toContain('Refresh Now');
  });

  it('disarms an already open spec deletion confirmation when its list fails', async () => {
    await mount(ApiSpecsPage);
    await settle(() => expect(host.textContent).toContain('Historical API'));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Delete spec Historical API"]')!.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    failures.set('api-specs', 503);
    await refetch(['apiSpecs']);
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(writes).toEqual([]);
  });

  it('keeps a replacement draft but disables its write after a failed list refresh', async () => {
    responses.set('api-specs/spec', { openapi: '3.1.0' });
    await mount(ApiSpecsPage);
    await settle(() => expect(host.textContent).toContain('Historical API'));
    const replace = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Replace')!;
    await act(async () => replace.click());
    const documentField = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="OpenAPI document"]',
    )!;
    await settle(() => expect(documentField.disabled).toBe(false));
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Replace Spec')!;
    expect(save.disabled).toBe(false);
    failures.set('api-specs', 503);
    await refetch(['apiSpecs']);
    await settle(() => expect(save.disabled).toBe(true));
    expect(documentField.isConnected).toBe(true);
    expect(documentField.value).toContain('3.1.0');
    await act(async () => save.click());
    expect(writes).toEqual([]);
  });

  it('keeps a genuine empty trust state and Create only when both reads agree', async () => {
    responses.set('gateway-trust/status', { configured: false, bundle: null });
    await mount(MeshPage);
    await tab('Trust');
    await settle(() => expect(host.textContent).toContain('Create Trust Bundle'));
    expect(host.textContent).toContain('has no SPIFFE trust bundle');
  });

  it.each([
    { Page: ProxyPage, path: '/proxies/$proxyId', tab: 'Plugins', endpoint: 'plugins/config',
      empty: page([]), text: 'No plugins run on this proxy.' },
    { Page: ConsumerPage, path: '/consumers/$consumerId',
    tab: 'Matched Proxies',
      endpoint: 'plugins/config', empty: page([]),
      text: 'No proxy is conclusively or conditionally matched for this consumer.' },
    { Page: AuditPage, endpoint: 'audit', empty: items([]), text: 'No audit events' },
    { Page: ApiSpecsPage, endpoint: 'api-specs', empty: items([]), text: 'No API specs yet' },
  ])('preserves successful absence: $text', async (c) => {
    responses.set(c.endpoint, c.empty);
    await mount(c.Page, c.path);
    if (c.tab) await tab(c.tab);
    await settle(() => expect(host.textContent).toContain(c.text));
    expect(host.textContent).not.toContain('Current state is unknown');
  });

  it.each([404, 503])('keeps first-load optional mode guidance for HTTP %s', async (status) => {
    failures.set('mesh/federation', status);
    await mount(MeshPage);
    await tab('Clusters');
    await settle(() => expect(host.textContent).toContain('may not be enabled in this mode'));
    expect(host.textContent).toContain('No remote clusters');
  });
});
