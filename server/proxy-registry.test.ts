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
// Namespace pages held until a test opens them, keyed `${id}:${offset}`.
const gates = new Map<string, { response: ServerResponse; page: string }>();
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
      if (url.searchParams.has('huge')) {
        // A fleet far larger than any scan budget. The three granted names
        // lead the first page; everything after them is ungranted.
        const total = 1_000_000;
        const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => (
          ['tenant-a', 'tenant-c', 'z-derived'][offset + i] ?? `bulk-${String(offset + i).padStart(7, '0')}`));
        response.end(JSON.stringify({ data, pagination: { offset, limit, total } }));
        return;
      }
      response.setHeader('etag', '"fleet-only"');
      const page = JSON.stringify({ data: names.slice(offset, offset + limit),
        pagination: { offset, limit, total: names.length } });
      if (url.searchParams.has('gate')) {
        gates.set(`${id}:${offset}`, { response, page });
        events.emit(`gated:${id}:${offset}`);
        return;
      }
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
let registry: typeof import('./namespace-registry.js');
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
function openGate(key: string) {
  const gate = gates.get(key)!;
  gates.delete(key);
  gate.response.end(gate.page);
}
const waiters = (count: number) => vi.waitFor(() => expect(registry.sharedScanStats().waiters).toBe(count));

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
    FERRUM_MAX_ACTIVE_LONG_READS: '3', FERRUM_MAX_LONG_READS_PER_PRINCIPAL: '2',
    FERRUM_NAMESPACE_SCAN_MAX_PAGES: '3',
  })) vi.stubEnv(key, value);
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  // The same module instance the app uses, to observe shared traversals.
  registry = await import('./namespace-registry.js');
  app = await buildApp({ serveStatic: false, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const session = await app.inject({ url: '/api/auth/session', headers: identity() });
  expect(session.statusCode).toBe(200);
  csrf = { cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': session.json().csrfToken };
});

afterAll(async () => {
  for (const response of held.values()) response.destroy();
  for (const gate of gates.values()) gate.response.destroy();
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
      ['/namespaces/z-derived?confirm=z-derived', 'DELETE', undefined, 204],
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
    expect((await call(
      '/api/proxy/namespaces/tenant-b?confirm=tenant-b',
      'DELETE',
      '',
      unrestricted,
    )).status).toBe(204);
    expect((await call('/api/proxy/namespaces/tenant-a', 'GET', '', identity({ 'x-registry-role': 'viewer' }))).status).toBe(200);
  });

  it(
    'requires a literal target-name confirmation for namespace cascades before forwarding',
    async () => {
      const before = arrivals.length;
      const beforeWrites = writes.length;
      // No confirmation remains the gateway-driven probe for empty namespaces.
      expect((await call('/api/proxy/namespaces/tenant-a', 'DELETE')).status).toBe(204);
      expect((await call('/api/proxy/namespaces/tenant-a?confirm=', 'DELETE')).status).toBe(400);
      const bareConfirmation = await call(
        '/api/proxy/namespaces/tenant-a?confirm=true',
        'DELETE',
      );
      expect(bareConfirmation.status).toBe(400);
      expect(bareConfirmation.body).toContain('confirm=tenant-a exactly');
      const mismatched = await call(
        '/api/proxy/namespaces/tenant-a?confirm=tenant-b',
        'DELETE',
      );
      expect(mismatched.status).toBe(400);
      expect((await call('/api/proxy/namespaces/tenant-a?confirm=%74enant-a', 'DELETE')).status)
        .toBe(400);
      expect((await call('/api/proxy/namespaces/%74enant-a?confirm=tenant-a', 'DELETE')).status)
        .toBe(204);
      expect(arrivals).toHaveLength(before + 2);
      expect(writes).toHaveLength(before + 2);
      expect(arrivals.at(-1)?.path).toBe('/namespaces/tenant-a?confirm=true');
    },
  );

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
    for (const role of ['viewer', 'operator']) {
      expect((await call('/api/proxy/namespaces', 'GET', '',
        identity({ 'x-registry-role': role, 'x-registry-grants': '*' }))).status).toBe(401);
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

  it('stops once every grant is found and refuses a traversal past its page budget', async () => {
    let before = arrivals.length;
    const found = await call('/api/proxy/namespaces?huge=1&limit=2');
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual({ data: ['tenant-a', 'tenant-c'], pagination: { offset: 0, limit: 2, total: 3 } });
    expect(arrivals.length - before).toBe(1);

    // A grant the fleet does not hold can only be ruled out by reading
    // everything, which the budget (3 pages here) does not allow. The answer
    // is unavailable, never the partial list found so far.
    before = arrivals.length;
    const refused = await call('/api/proxy/namespaces?huge=1', 'GET', '', identity({ 'x-registry-grants': 'tenant-a, absent' }));
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: 'Namespace list unavailable', code: 'FERRUM_BFF_NAMESPACE_SCAN_BUDGET' });
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(arrivals.slice(before).map((entry) => new URL(entry.path, 'http://fixture').searchParams.get('offset')))
      .toEqual(['0', '1000', '2000']);
  });

  it('shares one in-flight traversal between identical lists and keeps no result after it', async () => {
    const before = arrivals.length;
    const query = 'gate=1&id=coalesce';
    const firstPage = signal('gated:coalesce:0');
    const first = call(`/api/proxy/namespaces?${query}&offset=0&limit=1`);
    await firstPage;
    // Joins while the first traversal is still waiting for its first page.
    const second = call(`/api/proxy/namespaces?limit=5&${query}`);
    await waiters(2);
    expect(registry.sharedScanStats().scans).toBe(1);
    const secondPage = signal('gated:coalesce:1000');
    openGate('coalesce:0');
    await secondPage;
    openGate('coalesce:1000');
    const [one, all] = await Promise.all([first, second]);
    expect(JSON.parse(one.body)).toEqual({ data: ['tenant-a'], pagination: { offset: 0, limit: 1, total: 3 } });
    expect(JSON.parse(all.body)).toEqual({ data: ['tenant-a', 'tenant-c', 'z-derived'], pagination: { offset: 0, limit: 5, total: 3 } });
    expect(arrivals.length - before).toBe(2);
    expect(registry.sharedScanStats()).toEqual({ scans: 0, waiters: 0 });

    // A settled traversal is not a cache: the next list reads again.
    expect((await call('/api/proxy/namespaces?id=coalesce')).status).toBe(200);
    expect(arrivals.length - before).toBe(4);
  });

  it('stops the shared traversal when every waiting request has gone', async () => {
    const query = 'gate=1&id=abandoned';
    const firstPage = signal('gated:abandoned:0');
    const first = start(`/api/proxy/namespaces?${query}`);
    await firstPage;
    const second = start(`/api/proxy/namespaces?limit=1&${query}`);
    await waiters(2);
    const before = arrivals.length;
    const cancelled = signal('closed:abandoned');
    first.request.destroy();
    await waiters(1);
    second.request.destroy();
    // The pending upstream page is cancelled, and nothing reads further.
    await cancelled;
    gates.delete('abandoned:0');
    expect(registry.sharedScanStats()).toEqual({ scans: 0, waiters: 0 });
    expect(arrivals).toHaveLength(before);
  });

  it('keeps the traversal for the requests still waiting when one leaves', async () => {
    const query = 'gate=1&id=survivor';
    const firstPage = signal('gated:survivor:0');
    const leaving = start(`/api/proxy/namespaces?${query}`);
    await firstPage;
    const staying = call(`/api/proxy/namespaces?limit=5&${query}`);
    await waiters(2);
    // The request that started the traversal leaves; the other still gets
    // the whole result from the same traversal.
    leaving.request.destroy();
    await waiters(1);
    const secondPage = signal('gated:survivor:1000');
    openGate('survivor:0');
    await secondPage;
    openGate('survivor:1000');
    const response = await staying;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ data: ['tenant-a', 'tenant-c', 'z-derived'], pagination: { offset: 0, limit: 5, total: 3 } });
  });

  it('ends a shared traversal at its own deadline, not at the latest waiter\'s', async () => {
    const query = 'gate=1&id=deadline';
    const firstPage = signal('gated:deadline:0');
    const creator = call(`/api/proxy/namespaces?${query}`);
    await firstPage;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const joinedAt = performance.now();
    const joiner = call(`/api/proxy/namespaces?limit=1&${query}`);
    await waiters(2);
    const responses = await Promise.all([creator, joiner]);
    for (const response of responses) {
      expect(response.status).toBe(504);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'FERRUM_BFF_TIMEOUT', phase: 'response' });
    }
    // The joiner's own 4 s deadline was still about 1.5 s away: the
    // traversal's deadline, set when it started, ended it.
    expect(performance.now() - joinedAt).toBeLessThan(3500);
    gates.delete('deadline:0');
    expect(registry.sharedScanStats()).toEqual({ scans: 0, waiters: 0 });
  }, 10_000);

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

describe('long-running read admission over TCP', () => {
  let serial = 0;
  const as = (user: string) => identity({ 'x-registry-user': user });
  async function holdRead(user: string) {
    const id = `read-${++serial}`;
    const ready = signal(`held:${id}`);
    const client = start(`/api/proxy/config/apply-status?hold=1&id=${id}`, 'GET', '', as(user));
    await ready;
    return { ...client, id };
  }
  async function release(client: Awaited<ReturnType<typeof holdRead>>) {
    const response = held.get(client.id)!;
    held.delete(client.id);
    response.end('{}');
    expect((await client.result).status).toBe(200);
  }
  async function disconnect(client: Awaited<ReturnType<typeof holdRead>>) {
    const closed = signal(`closed:${client.id}`);
    client.request.destroy();
    await closed; // upstream cancellation proves the BFF observed the close
    held.delete(client.id);
  }
  async function assertFull() {
    const before = arrivals.length;
    const refused = await call('/api/proxy/config/apply-status', 'GET', '', as('reader-c'));
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ error: 'Too Many Requests', code: 'FERRUM_BFF_READ_CAPACITY', scope: 'all' });
    expect(arrivals).toHaveLength(before);
  }

  it('admits one subject only its share and every subject only the global pool, before any upstream call', async () => {
    const a1 = await holdRead('reader-a');
    const a2 = await holdRead('reader-a');
    try {
      const before = arrivals.length;
      const refused = await call('/api/proxy/config/apply-status', 'GET', '', as('reader-a'));
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('1');
      expect(JSON.parse(refused.body)).toEqual({ error: 'Too Many Requests', code: 'FERRUM_BFF_READ_CAPACITY', scope: 'principal' });
      // HEAD waits like GET, and backups and scoped namespace lists draw on
      // the same share.
      expect((await call('/api/proxy/config/apply-status', 'HEAD', '', as('reader-a'))).status).toBe(429);
      expect((await call('/api/proxy/backup', 'GET', '', as('reader-a'))).status).toBe(429);
      expect((await call('/api/proxy/namespaces', 'GET', '', as('reader-a'))).status).toBe(429);
      expect(arrivals).toHaveLength(before);
      // An ordinary read is not a long read.
      expect((await call('/api/proxy/proxies', 'GET', '', as('reader-a'))).status).toBe(200);

      const b1 = await holdRead('reader-b');
      try {
        await assertFull();
      } finally { await release(b1); }
      // Freed global capacity goes to another subject, not past a full share.
      await release(await holdRead('reader-c'));
    } finally {
      await release(a1);
      await release(a2);
    }
  }, 10_000);

  it('returns every permit exactly once on completion and on client disconnect', async () => {
    for (let round = 0; round < 3; round += 1) {
      await disconnect(await holdRead('reader-a'));
      await disconnect(await holdRead('reader-a'));
      await release(await holdRead('reader-a'));
      await disconnect(await holdRead('reader-b'));
    }
    const clients = [await holdRead('reader-a'), await holdRead('reader-a'), await holdRead('reader-b')];
    try {
      await assertFull();
    } finally {
      for (const client of clients) await release(client);
    }
  }, 20_000);
});
