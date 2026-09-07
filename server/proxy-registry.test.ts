import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'registry-proxy-test-proof-long-enough-123';
const names = [...Array.from({ length: 1007 }, (_, i) => `other-${String(i).padStart(4, '0')}`),
  'tenant-a', 'tenant-b', 'tenant-c', 'z-derived'].sort();
const grants = 'tenant-a, tenant-c, z-derived';
const arrivals: Array<{ path: string; method: string; token: string; headers: Record<string, unknown> }> = [];
const writes: Array<{ path: string; body: string }> = [];
const held = new Map<string, ServerResponse>();
const events = new EventEmitter();
// Intentionally does not enforce JWT namespace claims. The BFF must enforce
// its contract with a gateway that supports the documented optional setting.
const gateway = createServer((request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  const id = url.searchParams.get('id') ?? '';
  arrivals.push({ path: request.url!, method: request.method!,
    token: request.headers.authorization!.slice(7), headers: request.headers });
  response.once('close', () => events.emit(`closed:${id}`));
  events.emit(`arrived:${id}`);
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    if (request.method !== 'GET') writes.push({ path: request.url!, body });
    if (url.searchParams.has('hold')) {
      held.set(id, response);
      events.emit(`held:${id}`);
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/namespaces' && request.method === 'GET') {
      if (url.searchParams.has('failure')) {
        response.statusCode = 503;
        response.end('{"error":"other-private-name"}');
        return;
      }
      if (url.searchParams.has('legacy')) {
        response.end(JSON.stringify(names));
        return;
      }
      if (url.searchParams.has('oversize')) {
        response.end(JSON.stringify({ data: ['x'.repeat(1024 * 1024 + 1)] }));
        return;
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      response.setHeader('etag', '"fleet-only"');
      const page = JSON.stringify({ data: names.slice(offset, offset + limit),
        pagination: { offset, limit, total: names.length } });
      if (url.searchParams.has('slow-pages')) {
        const timer = setTimeout(() => response.end(page), 2300);
        response.once('close', () => clearTimeout(timer));
      } else response.end(page);
      return;
    }
    if (request.method === 'DELETE') {
      response.statusCode = 204;
      response.end();
    } else {
      response.statusCode = request.method === 'POST' && url.pathname === '/namespaces' ? 201 : 200;
      response.end(JSON.stringify({ name: url.pathname.split('/').at(-1), body }));
    }
  })().catch(() => response.destroy());
});

let app: FastifyInstance;
let csrf: Record<string, string> = {};
function identity(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-ferrum-auth-secret': SECRET, 'x-registry-user': 'registry-user',
    'x-registry-role': 'admin', 'x-registry-grants': grants,
    'x-ferrum-namespace': 'tenant-a', ...csrf, ...extra };
}

// Node's raw header array writes separate wire occurrences without folding
// them. All assertions exercise a listening buildApp() over real TCP.
function start(path: string, method = 'GET', body = '', headers = identity(), duplicate?: [string, string], complete = true) {
  const fields: Record<string, string> = { host: '127.0.0.1', connection: 'close',
    ...(method === 'GET' ? {} : { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body) + (complete ? 0 : 100)) }), ...headers };
  if (fields['transfer-encoding']) delete fields['content-length'];
  const raw = Object.entries(fields).flat();
  if (duplicate) raw.push(...duplicate);
  const request = httpRequest({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port,
    path, method, headers: raw });
  const result = new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    request.on('error', reject);
  });
  // Cancellation is an expected outcome in permit tests; install a rejection
  // observer immediately while preserving the original promise for assertions.
  void result.catch(() => {});
  request.setTimeout(5000, () => request.destroy(new Error('Fixture request timed out')));
  if (complete) request.end(body);
  else request.write(body);
  return { request, result };
}
const call = (path: string, method = 'GET', body = '', headers = identity()) => start(path, method, body, headers).result;
const signal = (name: string) => once(events, name, { signal: AbortSignal.timeout(3000) });

beforeAll(async () => {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  for (const [key, value] of Object.entries({
    NODE_ENV: 'production', FERRUM_AUTH_MODE: 'trusted-proxy',
    FERRUM_ADMIN_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    FERRUM_JWT_SECRET: 'registry-test-jwt-secret-long-enough-123',
    FERRUM_TRUSTED_PROXY_SECRET: SECRET, FERRUM_SECURE_COOKIES: 'false',
    FERRUM_TRUSTED_PROXY_USER_HEADER: 'x-registry-user',
    FERRUM_TRUSTED_PROXY_ROLE_HEADER: 'x-registry-role',
    FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER: 'x-registry-grants',
    FERRUM_READ_TIMEOUT: '4000', FERRUM_WRITE_TIMEOUT: '2000', FERRUM_UPLOAD_TIMEOUT: '4000',
    FERRUM_MAX_ACTIVE_UPLOADS: '4', FERRUM_MAX_LARGE_UPLOADS: '2',
  })) vi.stubEnv(key, value);
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const session = await app.inject({ url: '/api/auth/session', headers: identity() });
  expect(session.statusCode).toBe(200);
  csrf = { cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': session.json().csrfToken };
});

afterAll(async () => {
  for (const response of held.values()) response.destroy();
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe('registry authorization at the forwarding boundary', () => {
  it('denies ungranted path/body targets without any upstream arrival or write', async () => {
    const before = arrivals.length;
    const beforeWrites = writes.length;
    for (const path of ['/namespaces/tenant-b', '/%6eamespaces/%74enant-b']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await call(`/api/proxy${path}?confirm=true`, method, method === 'PUT' ? '{"description":null}' : '')).status).toBe(403);
      }
    }
    for (const [path, method, body] of [
      ['/namespaces', 'POST', '{"name":"tenant-b"}'],
      ['/namespaces/tenant-a', 'PUT', '{"name":"tenant-b"}'],
      ['/namespaces/tenant-b', 'PUT', '{"name":"tenant-a"}'],
      ['/namespaces/tenant-a', 'PUT', '{"na\\u006de":"tenant-b"}'],
      ['/namespaces/tenant-a', 'PUT', '{"name":"tenant-a","name":"tenant-b"}'],
    ]) expect((await call(`/api/proxy${path}`, method, body)).status).toBe(403);
    expect(arrivals).toHaveLength(before);
    expect(writes).toHaveLength(beforeWrites);
  });

  it('preserves granted create, description clear, rename, detail and both delete modes', async () => {
    const cases = [
      ['/namespaces', 'POST', { name: 'tenant-c', description: 'new' }, 201],
      ['/%6eamespaces/%74enant-a', 'GET', undefined, 200],
      ['/namespaces/tenant-a', 'PUT', { description: null }, 200],
      ['/namespaces/tenant-a', 'PUT', { description: '' }, 200],
      ['/namespaces/tenant-a', 'PUT', {}, 200],
      ['/namespaces/tenant-a', 'PUT', { name: 'tenant-c', description: '😀'.repeat(1024) }, 200],
      ['/namespaces/z-derived', 'DELETE', undefined, 204],
      ['/namespaces/z-derived?confirm=true', 'DELETE', undefined, 204],
    ] as const;
    for (const [path, method, body, status] of cases) {
      expect((await call(`/api/proxy${path}`, method, body ? JSON.stringify(body) : '')).status).toBe(status);
      expect(decodeJwt(arrivals.at(-1)!.token)).toMatchObject({ sub: 'registry-user', role: 'admin', ns: ['tenant-a', 'tenant-c', 'z-derived'] });
      if (body) expect(JSON.parse(writes.at(-1)!.body)).toEqual(body);
    }
    const unrestricted = identity();
    delete unrestricted['x-registry-grants'];
    expect((await call('/api/proxy/namespaces/tenant-b', 'GET', '', unrestricted)).status).toBe(200);
    expect((await call('/api/proxy/namespaces/tenant-b', 'PUT', '{"name":"new-name"}', unrestricted)).status).toBe(200);
    expect((await call('/api/proxy/namespaces', 'POST', '{"name":"new-name"}', unrestricted)).status).toBe(201);
    expect((await call('/api/proxy/namespaces/tenant-b?confirm=true', 'DELETE', '', unrestricted)).status).toBe(204);
    expect((await call('/api/proxy/namespaces/tenant-a', 'GET', '', identity({ 'x-registry-role': 'viewer' }))).status).toBe(200);
  });

  it('validates bounded JSON before publication and preserves authentication and roles', async () => {
    const before = arrivals.length;
    for (const body of ['{', '[]', 'null', '{"name":null}', '{"name":7}', '{"name":"*"}',
      '{"name":"tenant-*"}', '{"name":" tenant-a"}', '{"name":"tenant-a\\n"}', '{"description":{}}', '{"description":false}',
      JSON.stringify({ description: '😀'.repeat(1025) }), '{"description":"\\ud800"}',
      JSON.stringify({ description: '\ufeff'.repeat(1025) })]) {
      expect((await call('/api/proxy/namespaces/tenant-a', 'PUT', body)).status).toBe(400);
    }
    expect((await call('/api/proxy/namespaces', 'POST', '{}')).status).toBe(400);
    expect((await call('/api/proxy/namespaces', 'POST', '{"name":"tenant-a"}', identity({ 'x-registry-role': 'viewer' }))).status).toBe(403);
    expect((await call('/api/proxy/namespaces/tenant-a', 'DELETE', '', identity({ 'x-registry-role': 'operator' }))).status).toBe(403);
    expect((await call('/api/proxy/namespaces/tenant-a', 'PUT', '{}', identity({ 'x-csrf-token': 'invalid' }))).status).toBe(403);
    expect((await call('/api/proxy/namespaces', 'POST', '{}', identity({ 'content-length': String(2 * 1024 * 1024 + 1) }))).status).toBe(413);
    expect((await call('/api/proxy/namespaces', 'POST', ' '.repeat(2 * 1024 * 1024 + 1),
      identity({ 'transfer-encoding': 'chunked' }))).status).toBe(413);
    expect((await call('/api/proxy/namespaces/tenant-a/extra')).status).toBe(400);
    for (const grant of ['*', 'tenant-*']) {
      expect((await call('/api/proxy/namespaces', 'GET', '', identity({ 'x-registry-grants': grant }))).status).toBe(401);
    }
    expect(arrivals).toHaveLength(before);
    expect((await call('/api/proxy/namespaces/tenant-a', 'PUT', JSON.stringify({ description: '\u0085'.repeat(1025) }))).status).toBe(200);
  });

  it('filters before pagination across upstream pages and ignores name queries like Edge', async () => {
    const before = arrivals.length;
    const response = await call('/api/proxy/%6eamespaces?offset=1&limit=1&name=tenant-b', 'GET', '',
      identity({ 'if-none-match': '"fleet-only"', range: 'bytes=0-10' }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ data: ['tenant-c'], pagination: { offset: 1, limit: 1, total: 3 } });
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(arrivals.slice(before).map((entry) => entry.path)).toEqual([
      '/namespaces?offset=0&limit=1000&name=tenant-b', '/namespaces?offset=1000&limit=1000&name=tenant-b',
    ]);
    expect(arrivals.at(-1)!.headers['if-none-match']).toBeUndefined();
    expect(arrivals.at(-1)!.headers.range).toBeUndefined();
    for (const query of ['', '?limit=0', '?limit=18446744073709551615', '?legacy=1']) {
      const page = await call(`/api/proxy/namespaces${query}`);
      expect(JSON.parse(page.body).data).toEqual(['tenant-a', 'tenant-c', 'z-derived']);
      expect(page.body).not.toContain('other-');
      expect(page.body).not.toContain('tenant-b');
    }
    const last = await call('/api/proxy/namespaces?offset=2&limit=1');
    expect(JSON.parse(last.body).data).toEqual(['z-derived']);
    const beyond = await call('/api/proxy/namespaces?offset=9223372036854775807');
    expect(beyond.body).toContain('"offset":9223372036854775807');
    expect(JSON.parse(beyond.body).data).toEqual([]);
    const noMatches = await call('/api/proxy/namespaces', 'GET', '', identity({ 'x-registry-grants': 'absent', 'x-ferrum-namespace': 'absent' }));
    expect(JSON.parse(noMatches.body).pagination.total).toBe(0);
    const unrestricted = identity();
    delete unrestricted['x-registry-grants'];
    const all = await call('/api/proxy/namespaces?offset=0&limit=2', 'GET', '', unrestricted);
    expect(JSON.parse(all.body).pagination.total).toBe(names.length);
  });

  it('rejects malformed pagination before upstream reads and bounds upstream list bodies', async () => {
    const before = arrivals.length;
    for (const query of ['offset=-1', 'offset=1.5', 'offset=9223372036854775808', 'limit=-1',
      'limit=18446744073709551616', 'limit=wat', 'offset=bad&offset=0', 'offset=1%0a']) {
      expect((await call(`/api/proxy/namespaces?${query}`)).status).toBe(400);
    }
    expect(arrivals).toHaveLength(before);
    const failure = await call('/api/proxy/namespaces?failure=1');
    expect(failure.status).toBe(503);
    expect(failure.body).not.toContain('other-private-name');
    expect((await call('/api/proxy/namespaces?oversize=1')).status).toBe(502);
  });

  it('keeps one response deadline across every filtered list page', async () => {
    const before = arrivals.length;
    const started = performance.now();
    const response = await call('/api/proxy/namespaces?slow-pages=1');
    expect(response.status).toBe(504);
    expect(response.body).toContain('FERRUM_BFF_TIMEOUT');
    expect(arrivals.length - before).toBe(2);
    expect(performance.now() - started).toBeLessThan(4800);
  }, 8000);

  it('bounds an incomplete registry body before opening an upstream request', async () => {
    const before = arrivals.length;
    const client = start('/api/proxy/namespaces', 'POST', '{"name":', identity(), undefined, false);
    try {
      const response = await client.result;
      expect(response.status).toBe(504);
      expect(response.body).toContain('"phase":"upload"');
      expect(arrivals).toHaveLength(before);
    } finally { client.request.destroy(); }
  }, 5000);

  it('uniformly refuses duplicate raw configured identity headers, including mixed case', async () => {
    const before = arrivals.length;
    for (const [name, value] of Object.entries({ 'X-Ferrum-Auth-Secret': SECRET,
      'X-Registry-User': 'another-user', 'X-Registry-Role': 'admin', 'X-Registry-Grants': 'tenant-b' })) {
      for (const path of ['/api/auth/session', '/api/proxy/namespaces/tenant-a']) {
        const response = await start(path, 'GET', '', identity(), [name, value]).result;
        expect(response.status).toBe(401);
      }
    }
    expect(arrivals).toHaveLength(before);
    const response = await call('/api/auth/session');
    expect(JSON.parse(response.body).principal.namespaces).toEqual(['tenant-a', 'tenant-c', 'z-derived']);
  });
});

describe('upload reservation lifetime over TCP', () => {
  let serial = 0;
  async function hold(path: string, complete = true) {
    const id = String(++serial);
    const ready = signal(`${complete ? 'held' : 'arrived'}:${id}`);
    const client = start(`/api/proxy${path}?hold=1&id=${id}`, 'POST', '{}', identity(), undefined, complete);
    await ready;
    return { ...client, id };
  }
  async function disconnect(client: Awaited<ReturnType<typeof hold>>) {
    const closed = signal(`closed:${client.id}`);
    client.request.destroy();
    await closed; // upstream cancellation proves the BFF observed the close
    held.delete(client.id);
  }
  async function finish(client: Awaited<ReturnType<typeof hold>>, error = false) {
    const response = held.get(client.id)!;
    held.delete(client.id);
    if (error) response.destroy();
    else response.end('{}');
    expect((await client.result).status).toBe(error ? 502 : 200);
  }
  async function assertFull(path: string, count: number, scope: string) {
    const clients: Array<Awaited<ReturnType<typeof hold>>> = [];
    try {
      for (let i = 0; i < count; i += 1) clients.push(await hold(path));
      const before = arrivals.length;
      const rejected = await call(`/api/proxy${path}`, 'POST', '{}');
      expect(rejected.status).toBe(429);
      expect(JSON.parse(rejected.body).scope).toBe(scope);
      expect(arrivals).toHaveLength(before);
    } finally {
      for (const client of clients) await finish(client);
    }
  }

  it.each([['/proxies', 4, 'all'], ['/restore', 2, 'large'], ['/api-specs', 2, 'large']] as const)(
    'restores every permit after repeated completed-body disconnects on %s', async (path, count, scope) => {
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < count; i += 1) await disconnect(await hold(path));
        await assertFull(path, count, scope);
      }
    }, 20_000);

  it('does not over-release under mixed finish/error/abort/close while another request holds capacity', async () => {
    const survivor = await hold('/restore');
    try {
      await finish(await hold('/api-specs'));
      await finish(await hold('/api-specs'), true);
      await disconnect(await hold('/api-specs', false));
      await disconnect(await hold('/api-specs'));
      const second = await hold('/api-specs');
      try {
        expect(JSON.parse((await call('/api/proxy/restore', 'POST', '{}')).body).scope).toBe('large');
        // The two large reservations also occupy exactly two global slots.
        await assertFull('/proxies', 2, 'all');
        expect(JSON.parse((await call('/api/proxy/api-specs', 'POST', '{}')).body).scope).toBe('large');
      } finally { await finish(second); }
    } finally { await finish(survivor); }
    await assertFull('/restore', 2, 'large');
    await assertFull('/proxies', 4, 'all');
  }, 20_000);
});
