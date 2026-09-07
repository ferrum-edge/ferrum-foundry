import { EventEmitter, once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const PROXY_SECRET = 'path-test-trusted-proxy-secret-long-enough';
const TENANT_DATA = 'tenant-b-private-record';
const arrivals: Array<{ url: string; method: string; namespace: string | undefined; token: string }> = [];
const publications: Array<{ url: string; body: string }> = [];
const held: ServerResponse[] = [];
const signals = new EventEmitter();
const gateway = createServer((request, response) => {
  const url = request.url ?? '';
  arrivals.push({
    url, method: request.method ?? '',
    namespace: request.headers['x-ferrum-namespace'] as string | undefined,
    token: request.headers.authorization?.replace(/^Bearer /, '') ?? '',
  });
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      publications.push({ url, body: Buffer.concat(chunks).toString('utf8') });
    }
    response.setHeader('content-type', 'application/json');
    if (url.includes('hold=1')) {
      held.push(response);
      signals.emit('held');
      return;
    }
    if (url.includes('delay=1')) {
      const timer = setTimeout(() => response.end('{"ok":true}'), 700);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    response.end(JSON.stringify({ data: TENANT_DATA }));
  })().catch(() => response.destroy());
});

let app: FastifyInstance;
let csrfHeaders: Record<string, string>;

function identity(role = 'operator', namespace: string | undefined = 'tenant-a'): Record<string, string> {
  return {
    'x-ferrum-auth-secret': PROXY_SECRET,
    'x-forwarded-user': 'path-test-user',
    'x-ferrum-role': role,
    'x-ferrum-namespaces': 'tenant-a',
    ...(namespace === undefined ? {} : { 'x-ferrum-namespace': namespace }),
    ...csrfHeaders,
  };
}

// Deliberately bypass URL/HTTP client normalization. The exact supplied target
// is written into the request line of an actual TCP connection to buildApp().
function rawRequest(
  target: string,
  method = 'GET',
  headers: Record<string, string> = identity(),
  body = '',
  trickle = false,
): Promise<{ status: number; wire: string }> {
  const port = (app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => socket.destroy(new Error('Raw BFF request timed out')), 6000);
    socket.once('close', () => {
      clearInterval(timer);
      clearTimeout(deadline);
    });
    socket.on('error', reject);
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => {
      const wire = Buffer.concat(chunks).toString('utf8');
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(wire)?.[1] ?? 0), wire });
      socket.destroy();
    });
    socket.on('connect', () => {
      const fields = {
        host: `127.0.0.1:${port}`,
        connection: 'close',
        ...(method === 'GET' || method === 'HEAD' ? {} : {
          'content-type': 'application/json',
          ...(trickle ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(Buffer.byteLength(body)) }),
        }),
        ...headers,
      };
      socket.write(`${method} ${target} HTTP/1.1\r\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${body}`);
      if (trickle) {
        socket.write('1\r\nx\r\n');
        timer = setInterval(() => socket.write('1\r\nx\r\n'), 100);
      }
    });
  });
}

beforeAll(async () => {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const env = {
    NODE_ENV: 'production',
    FERRUM_ADMIN_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    FERRUM_JWT_SECRET: 'path-test-jwt-signing-secret-long-enough',
    FERRUM_AUTH_MODE: 'trusted-proxy',
    FERRUM_TRUSTED_PROXY_SECRET: PROXY_SECRET,
    FERRUM_SECURE_COOKIES: 'false',
    FERRUM_READ_TIMEOUT: '300',
    FERRUM_WRITE_TIMEOUT: '2000',
    FERRUM_UPLOAD_TIMEOUT: '4000',
    FERRUM_MAX_ACTIVE_UPLOADS: '8',
    FERRUM_MAX_LARGE_UPLOADS: '2',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity() });
  expect(session.statusCode).toBe(200);
  csrfHeaders = {
    cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': session.json().csrfToken,
  };
});

afterAll(async () => {
  for (const response of held.splice(0)) response.end('{}');
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe('raw BFF path confinement', () => {
  it('refuses ungranted tenant reads and writes without any upstream arrival or publication', async () => {
    const beforeReads = arrivals.length;
    const beforeWrites = publications.length;
    const suffixes = [
      '/proxies',
      '/admin/tls/../../proxies',
      '/admin/tls/%2e%2e/%2e%2e/proxies',
      ...['%09', '%0a', '%0d', '%00', '%1f', '%7f'].flatMap((control) => [
        `/admin/tls/..${control}/..${control}/proxies`,
        `/admin/tls/.${control}./.${control}./proxies`,
      ]),
      '/admin/tls/%252e%252e/%252e%252e/proxies',
      '/admin/tls/%2f..%2f..%2fproxies',
      '/admin/tls/%5c..%5c..%5cproxies',
      '/admin/tls/..\\..\\proxies',
      '/admin//tls/inventory',
      '/admin/tls/unknown',
      '/admin/tls/inventory/extra',
      '/admin/tls/%zz/proxies',
      '/admin/tls/%c0%af/proxies',
    ];
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const suffix of suffixes) {
        const response = await rawRequest(`/api/proxy${suffix}`, method,
          identity(method === 'GET' ? 'viewer' : 'operator', 'tenant-b'),
          method === 'GET' ? '' : '{"id":"must-not-publish"}');
        expect([400, 403], `${method} ${suffix}`).toContain(response.status);
        expect(response.wire).not.toContain(TENANT_DATA);
        expect(arrivals).toHaveLength(beforeReads);
        expect(publications).toHaveLength(beforeWrites);
      }
    }
  }, 15_000);

  it('also rejects unsafe targets for granted and unrestricted administrators', async () => {
    const before = arrivals.length;
    for (const suffix of ['..%09/proxies', '%252fproxies', '%2fproxies', 'a//b', '%7f', '%zz']) {
      for (const unrestricted of [false, true]) {
        const headers = identity('admin');
        if (unrestricted) delete headers['x-ferrum-namespaces'];
        const response = await rawRequest(`/api/proxy/${suffix}`, 'POST', headers, '{}');
        expect(response.status).toBe(400);
      }
    }
    expect(arrivals).toHaveLength(before);
  });

  it('refuses raw request-line controls without contacting upstream', async () => {
    const before = arrivals.length;
    for (const control of ['\0', '\t', '\n', '\r', '\x1f', '\x7f']) {
      const response = await rawRequest(`/api/proxy/admin/tls/..${control}/proxies`);
      expect(response.status).toBe(400);
    }
    expect(arrivals).toHaveLength(before);
  });

  it('preserves normal routes, escaped identifiers, queries, and signed identity', async () => {
    for (const [input, upstream] of [
      ['/api/proxy/proxies', '/proxies'],
      ['/%61pi/proxy/proxies', '/proxies'],
      ['/api/proxy/proxies/a%20b', '/proxies/a%20b'],
      ['/api/proxy/proxies/caf%C3%A9', '/proxies/caf%C3%A9'],
      ['/api/proxy/proxies/a%3Fb%23c', '/proxies/a%3Fb%23c'],
      ['/api/proxy/proxies/a.b?tag=a%2Fb&tag=a+b&cursor=%2525&empty=', '/proxies/a.b?tag=a%2Fb&tag=a+b&cursor=%2525&empty='],
    ]) {
      const response = await rawRequest(input, 'GET', identity('viewer'));
      expect(response.status).toBe(200);
      expect(response.wire).toContain(TENANT_DATA);
      expect(arrivals.at(-1)).toMatchObject({ url: upstream, method: 'GET', namespace: 'tenant-a' });
      expect(decodeJwt(arrivals.at(-1)!.token)).toMatchObject({ sub: 'path-test-user', role: 'viewer', ns: 'tenant-a' });
    }
    const body = '{ "id": "normal-write" }';
    expect((await rawRequest('/api/proxy/proxies', 'POST', identity(), body)).status).toBe(200);
    expect(publications.at(-1)).toEqual({ url: '/proxies', body });
    expect(decodeJwt(arrivals.at(-1)!.token)).toMatchObject({ role: 'operator', ns: 'tenant-a' });
  });

  it('exempts real fleet operations and refuses unsupported method/path combinations', async () => {
    for (const [method, path] of [
      ['GET', '/admin/tls/inventory'], ['GET', '/admin/tls/certificates/cert-1'],
      ['GET', '/admin/tls/acme/orders/order-1'], ['POST', '/admin/tls/validate'],
      ['POST', '/admin/tls/rotate/all'], ['POST', '/admin/tls/acme/orders/order-1/finalize'],
    ]) {
      const headers = identity(method === 'GET' ? 'operator' : 'admin');
      delete headers['x-ferrum-namespace'];
      expect((await rawRequest(`/api/proxy${path}`, method, headers, method === 'POST' ? '{}' : '')).status).toBe(200);
      expect(arrivals.at(-1)).toMatchObject({ url: path, method, namespace: undefined });
    }
    const before = arrivals.length;
    for (const [method, path] of [
      ['POST', '/admin/tls/inventory'], ['PUT', '/admin/tls/acme/orders/id'],
      ['GET', '/admin/tls/acme/orders/id/finalize'], ['GET', '/admin/tls/unknown'],
    ]) {
      expect((await rawRequest(`/api/proxy${path}`, method, identity('operator', 'tenant-b'), method === 'GET' ? '' : '{}')).status).toBe(403);
    }
    expect(arrivals).toHaveLength(before);
  });

  it('uses canonical paths for body limits and refuses oversize ordinary bodies before publication', async () => {
    const before = arrivals.length;
    const tooLarge = String(2 * 1024 * 1024 + 1);
    // Send only headers: an oversize declared body must never reach upstream.
    const rejected = await rawRequest('/api/proxy/%70roxies', 'POST', { ...identity(), 'content-length': tooLarge });
    expect(rejected.status).toBe(413);
    expect(rejected.wire).toContain('FERRUM_BFF_BODY_LIMIT');
    expect(arrivals).toHaveLength(before);
    const body = 'x'.repeat(Number(tooLarge));
    for (const path of ['/%61pi-specs', '/%72estore']) {
      expect((await rawRequest(`/api/proxy${path}`, 'POST', identity(), body)).status).toBe(200);
      expect(publications.at(-1)).toEqual({ url: decodeURIComponent(path), body });
    }
  });

  it('charges encoded large routes to the large-upload pool without charging ordinary routes', async () => {
    const pending: Array<ReturnType<typeof rawRequest>> = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const ready = once(signals, 'held', { signal: AbortSignal.timeout(2500) });
        pending.push(rawRequest(`/api/proxy/%72estore?hold=1&id=${index}`, 'POST', identity(), '{}'));
        await ready;
      }
      const before = arrivals.length;
      const full = await rawRequest('/api/proxy/%61pi-specs', 'POST', identity(), '{}');
      expect(full.status).toBe(429);
      expect(full.wire).toContain('"scope":"large"');
      expect(arrivals).toHaveLength(before);
      const unsafe = await rawRequest('/api/proxy/api-specs/..%09/proxies', 'POST', identity(), '{}');
      expect(unsafe.status).toBe(400);
      expect(arrivals).toHaveLength(before);
      expect((await rawRequest('/api/proxy/proxies', 'POST', identity(), '{}')).status).toBe(200);
    } finally {
      for (const response of held.splice(0)) response.end('{}');
      await Promise.all(pending);
    }
    expect((await rawRequest('/api/proxy/api-specs', 'POST', identity(), '{}')).status).toBe(200);
  });

  it('uses canonical paths for waiting deadlines and keeps ordinary routes bounded', async () => {
    const ordinary = await rawRequest('/api/proxy/%70roxies?delay=1');
    expect(ordinary.status).toBe(504);
    expect(ordinary.wire).toContain('FERRUM_BFF_TIMEOUT');
    for (const [method, path] of [
      ['GET', '/config/%61pply-status'], ['GET', '/%62ackup'],
      ['POST', '/admin/tls/acme/orders/order-1/%66inalize'], ['POST', '/%72estore'],
    ]) {
      expect((await rawRequest(`/api/proxy${path}?delay=1`, method, identity('admin'), method === 'POST' ? '{}' : '')).status).toBe(200);
      expect(arrivals.at(-1)?.url).toBe(`${decodeURIComponent(path)}?delay=1`);
    }
  });

  it.each([
    ['/%70roxies', 1500],
    ['/%61pi-specs', 3500],
  ] as const)('bounds a continuous raw upload to %s without publishing it', async (path, minimumMs) => {
    const before = publications.length;
    const started = performance.now();
    const response = await rawRequest(`/api/proxy${path}`, 'POST', identity(), '', true);
    expect(response.status).toBe(504);
    expect(response.wire).toContain('"phase":"upload"');
    expect(response.wire).toContain('"reason":"deadline"');
    expect(performance.now() - started).toBeGreaterThan(minimumMs);
    expect(arrivals.at(-1)?.url).toBe(decodeURIComponent(path));
    expect(publications).toHaveLength(before);
  }, 8000);
});
