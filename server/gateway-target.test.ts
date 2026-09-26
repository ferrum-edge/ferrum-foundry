import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'gateway-target-login-fixture-long-enough';
const SECRET = 'gateway-target-signing-fixture-long-enough';

interface Gateway {
  name: string;
  server: Server;
  origin: string;
  seen: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }>;
  hold?: (url: string) => boolean;
  held: ServerResponse[];
}

let gateways: Gateway[] = [];
let app: FastifyInstance | undefined;
let session: Record<string, string>;
let loginTarget: string;

// Two independent gateways that both serve a `demo` namespace, with clearly
// different resources, as the issue's reproduction requires.
async function startGateway(name: string): Promise<Gateway> {
  const gateway: Gateway = { name, server: createServer(), origin: '', seen: [], held: [] };
  gateway.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    gateway.seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (gateway.hold?.(request.url ?? '')) {
      gateway.held.push(response);
      return;
    }
    response.end(JSON.stringify({ gateway: name, items: [{ id: `${name}-proxy` }], total: 2 }));
  });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  gateway.origin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  gateways.push(gateway);
  return gateway;
}

async function buildBff(a: Gateway, b: Gateway, runtimeSettings = 'true'): Promise<FastifyInstance> {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test',
    FERRUM_AUTH_MODE: 'static',
    FERRUM_ADMIN_URL: a.origin,
    FERRUM_ADMIN_ALLOWED_ORIGINS: b.origin,
    FERRUM_ADMIN_ALLOWED_CIDRS: '127.0.0.1/32',
    FERRUM_ALLOW_RUNTIME_SETTINGS: runtimeSettings,
    FERRUM_JWT_SECRET: SECRET,
    FERRUM_BFF_AUTH_TOKEN: TOKEN,
    FERRUM_SECURE_COOKIES: 'false',
  })) vi.stubEnv(key, value);
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN } });
  expect(login.statusCode).toBe(200);
  loginTarget = targetOf(login);
  session = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': login.json().csrfToken as string,
  };
  return app;
}

function targetOf(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['x-foundry-gateway-target'];
  expect(typeof value).toBe('string');
  return value as string;
}

// `inject` is lazy until awaited; an async wrapper dispatches it at once, so a
// held request is really in flight while the test changes the target.
async function proxied(url: string, target: string | undefined, method: 'GET' | 'POST' | 'DELETE' = 'GET') {
  return app!.inject({
    method,
    url: `/api/proxy${url}`,
    headers: {
      ...session,
      'x-ferrum-namespace': 'demo',
      ...(target !== undefined && { 'x-foundry-gateway-target': target }),
    },
    ...(method === 'POST' && { payload: { id: 'drafted-against-a' } }),
  });
}

async function switchTo(gateway: Gateway, declared: string) {
  return app!.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { ...session, 'x-foundry-gateway-target': declared },
    payload: { adminUrl: gateway.origin },
  });
}

beforeEach(() => {
  gateways = [];
});

afterEach(async () => {
  for (const gateway of gateways) for (const response of gateway.held) response.end('{}');
  await app?.close();
  app = undefined;
  for (const gateway of gateways) {
    gateway.server.closeAllConnections();
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

describe('gateway target identity', () => {
  it('is a stable keyed digest that changes with the destination and never reveals it', async () => {
    const { gatewayTargetId } = await import('./gateway-target.js');
    const a = gatewayTargetId({ adminUrl: 'https://a.example', jwtSecret: SECRET });
    expect(gatewayTargetId({ adminUrl: 'https://a.example', jwtSecret: SECRET })).toBe(a);
    expect(gatewayTargetId({ adminUrl: 'https://b.example', jwtSecret: SECRET })).not.toBe(a);
    expect(gatewayTargetId({ adminUrl: 'https://a.example', jwtSecret: `${SECRET}-rotated` })).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toContain('a.example');
  });
});

describe('gateway target binding across a runtime adminUrl change', () => {
  it('names the target on login, session, settings, and proxied responses', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const session1 = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: session });
    const targetA = targetOf(session1);
    expect(targetA).toBe(loginTarget);
    const read = await proxied('/proxies', targetA);
    expect(read.statusCode).toBe(200);
    expect(targetOf(read)).toBe(targetA);
    expect(read.json().gateway).toBe('A');
    // The declaration is Foundry's own; the gateway never sees it.
    expect(a.seen.at(-1)?.headers['x-foundry-gateway-target']).toBeUndefined();
    const settings = await app!.inject({ method: 'GET', url: '/api/settings', headers: session });
    expect(targetOf(settings)).toBe(targetA);
  });

  it('refuses every request declared against the replaced target before it reaches the new one', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const targetA = targetOf(await proxied('/proxies', undefined));

    const saved = await switchTo(b, targetA);
    expect(saved.statusCode).toBe(200);
    const targetB = targetOf(saved);
    expect(targetB).not.toBe(targetA);
    expect(targetOf(await app!.inject({ method: 'GET', url: '/api/auth/session', headers: session })))
      .toBe(targetB);

    const seenByA = a.seen.length;
    // A read, a create drafted against A, and a delete: same principal, same
    // namespace header, same ids — none of them may be answered by B.
    const requests = [['/proxies', 'GET'], ['/proxies', 'POST'], ['/proxies/A-proxy', 'DELETE']] as const;
    for (const [url, method] of requests) {
      const stale = await proxied(url, targetA, method);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'FERRUM_BFF_GATEWAY_TARGET_CHANGED' });
      expect(targetOf(stale)).toBe(targetB);
    }
    const status = await app!.inject({
      method: 'GET',
      url: '/api/settings/status',
      headers: { ...session, 'x-foundry-gateway-target': targetA },
    });
    expect(status.statusCode).toBe(409);
    expect(b.seen).toEqual([]);
    expect(a.seen.length).toBe(seenByA);

    // Declared against the current target, the same request is B's to answer.
    const current = await proxied('/proxies', targetB);
    expect(current.statusCode).toBe(200);
    expect(current.json().gateway).toBe('B');
  });

  it('stops a paginated traversal whose first page was answered by the replaced target', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const targetA = targetOf(await app!.inject({ method: 'GET', url: '/api/auth/session', headers: session }));

    a.hold = (url) => url.startsWith('/proxies?offset=0');
    const firstPage = proxied('/proxies?offset=0&limit=1', targetA);
    await vi.waitFor(() => expect(a.held).toHaveLength(1));
    expect((await switchTo(b, targetA)).statusCode).toBe(200);
    a.held.shift()!.end(JSON.stringify({ gateway: 'A', items: [{ id: 'A-proxy' }], total: 2 }));
    const page1 = await firstPage;
    expect(page1.json().gateway).toBe('A');

    // Equal collection totals on A and B must not let page two come from B.
    const page2 = await proxied('/proxies?offset=1&limit=1', targetA);
    expect(page2.statusCode).toBe(409);
    expect(b.seen).toEqual([]);
  });

  it('refuses a settings save drafted against the replaced target instead of reverting it', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const targetA = targetOf(await app!.inject({ method: 'GET', url: '/api/settings', headers: session }));
    const targetB = targetOf(await switchTo(b, targetA));

    // The stale tab's form resubmits the adminUrl it was seeded with.
    const stale = await app!.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { ...session, 'x-foundry-gateway-target': targetA },
      payload: { adminUrl: a.origin, jwtTtl: 600 },
    });
    expect(stale.statusCode).toBe(409);
    const settings = await app!.inject({ method: 'GET', url: '/api/settings', headers: session });
    expect(settings.json()).toMatchObject({ adminUrl: b.origin, jwtTtl: 900 });
    expect(targetOf(settings)).toBe(targetB);
  });

  it('keeps the target for a save that does not change the destination', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const targetA = targetOf(await app!.inject({ method: 'GET', url: '/api/settings', headers: session }));
    const saved = await app!.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { ...session, 'x-foundry-gateway-target': targetA },
      payload: { adminUrl: a.origin, jwtIssuer: 'same-gateway' },
    });
    expect(saved.statusCode).toBe(200);
    expect(targetOf(saved)).toBe(targetA);
    expect((await proxied('/proxies', targetA)).statusCode).toBe(200);
  });

  it('still refuses disabled runtime settings and disallowed origins', async () => {
    const a = await startGateway('A');
    const b = await startGateway('B');
    await buildBff(a, b);
    const targetA = targetOf(await app!.inject({ method: 'GET', url: '/api/settings', headers: session }));
    const denied = await app!.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { ...session, 'x-foundry-gateway-target': targetA },
      payload: { adminUrl: 'http://127.0.0.1:1' },
    });
    expect(denied.statusCode).toBe(400);
    expect(targetOf(denied)).toBe(targetA);
    await app!.close();

    await buildBff(a, b, 'false');
    const immutable = await switchTo(b, targetA);
    expect(immutable.statusCode).toBe(403);
    expect((await proxied('/proxies', targetA)).json().gateway).toBe('A');
  });
});
