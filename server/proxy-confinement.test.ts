import { EventEmitter, once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetch as upstreamFetch } from 'undici';
import { generateToken } from './jwt.js';

vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return { ...original, fetch: vi.fn(original.fetch) };
});
vi.mock('./jwt.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./jwt.js')>();
  return { ...original, generateToken: vi.fn(original.generateToken) };
});

const PROXY_SECRET = 'path-test-trusted-proxy-secret-long-enough';
const TENANT_DATA = 'tenant-b-private-record';
const SNAPSHOT_TOO_LARGE = 'Namespace snapshot exceeds the 64 MiB conditional-authority bound';
const MASKED_CONSUMER = {
  id: 'consumer-1',
  credentials: { keyauth: [{ key: '[REDACTED]' }], jwt: [{ secret: '[REDACTED]' }] },
};
const arrivals: Array<{ url: string; method: string; namespace: string | undefined; token: string }> = [];
const publications: Array<{ url: string; body: string }> = [];
const held: ServerResponse[] = [];
const signals = new EventEmitter();

// Edge v0.9.13 conditional snapshot paths: a conditional backup read, a
// tagged restore, and the two deployment mutations.
function conditionalSnapshot(method: string, url: string, ifMatch: string | undefined): boolean {
  const target = new URL(url, 'http://gateway.test');
  if (method === 'POST' && target.pathname === '/restore') return ifMatch !== undefined;
  return target.searchParams.get('conditional') === 'true';
}

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
    if (conditionalSnapshot(request.method ?? '', url, request.headers['if-match'])) {
      // Deterministic NamespaceSnapshotTooLarge: nothing was issued or applied.
      response.statusCode = 507;
      response.end(JSON.stringify({ error: SNAPSHOT_TOO_LARGE }));
      return;
    }
    const path = new URL(url, 'http://gateway.test').pathname;
    if (path === '/consumers') {
      response.end(JSON.stringify({ data: [MASKED_CONSUMER] }));
    } else if (/^\/consumers\/[^/]+\/?$/.test(path)) {
      response.end(JSON.stringify(MASKED_CONSUMER));
    } else {
      response.end(JSON.stringify({ data: TENANT_DATA }));
    }
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
  it('denies credential verification before signing or fetch for all forwarded methods', async () => {
    const beforeArrivals = arrivals.length;
    const beforeTokens = vi.mocked(generateToken).mock.calls.length;
    const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
    const paths = [
      '/api/proxy/consumers/consumer-1/verification',
      '/api/proxy/consumers/consumer-1/verification/',
      '/api/proxy/consumers/consumer-1/verification?conditional=true',
      '/api/proxy/%63onsumers/%63onsumer-1/%76erification',
      '/api/proxy/consumers/a%20b/verification/',
      '/api/proxy/consumers/caf%C3%A9/verification',
      '/api/proxy/consumers/a%3Fb%23c/verification/?x=a%2Fb',
      '/%61pi/pr%6fxy/%63onsumers/a%3Ab%40c/verific%61tion',
    ];
    for (const method of app.supportedMethods) {
      for (const path of paths) {
        const response = await rawRequest(
          path, method, identity('admin'), method === 'GET' || method === 'HEAD' ? '' : '{}',
        );
        expect(response.status, `${method} ${path}`).toBe(403);
        if (method !== 'HEAD') expect(response.wire).toContain('FERRUM_BFF_CREDENTIAL_READ_DENIED');
        expect(arrivals).toHaveLength(beforeArrivals);
        expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
        expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
      }
    }
  }, 15_000);

  it.each(['viewer', 'operator', 'admin'])(
    'denies deployment snapshots for %s before signing or fetch for all forwarded methods',
    async (role) => {
      const beforeArrivals = arrivals.length;
      const beforeWrites = publications.length;
      const beforeTokens = vi.mocked(generateToken).mock.calls.length;
      const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
      const paths = [
        '/api/proxy/deployment-snapshot',
        '/api/proxy/deployment-snapshot/',
        '/api/proxy/deployment-snapshot?resources=consumers',
        '/api/proxy/deployment-snapshot/?note=a%2Fb&query=%zz?extra=1',
        '/api/proxy/%64eployment-%73napshot',
        '/api/proxy/deploym%65nt-snapshot/',
        '/%61pi/pr%6fxy/%64eployment-%73napshot/?conditional=true',
      ];
      for (const method of app.supportedMethods) {
        for (const path of paths) {
          const response = await rawRequest(
            path,
            method,
            identity(role),
            method === 'GET' || method === 'HEAD' ? '' : '{}',
          );
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
          if (method !== 'HEAD') {
            expect(response.wire).toContain('FERRUM_BFF_CREDENTIAL_READ_DENIED');
            expect(response.wire).toContain('Deployment snapshot is not available through Foundry');
          }
          expect(arrivals).toHaveLength(beforeArrivals);
          expect(publications).toHaveLength(beforeWrites);
          expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
          expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
        }
      }
    },
    15_000,
  );

  it('preserves authentication, namespace, CSRF, and unsafe-path checks before denial', async () => {
    const beforeArrivals = arrivals.length;
    const beforeTokens = vi.mocked(generateToken).mock.calls.length;
    const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
    for (const path of [
      '/api/proxy/consumers/consumer-1/verification',
      '/api/proxy/deployment-snapshot',
    ]) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const anonymous = await rawRequest(path, method, {}, method === 'POST' ? '{}' : '');
        expect(anonymous.status).toBe(401);
        expect(anonymous.wire).not.toContain('FERRUM_BFF_CREDENTIAL_READ_DENIED');
      }
      const denied = await rawRequest(path, 'GET', identity('admin', 'tenant-b'));
      expect(denied.status).toBe(403);
      expect(denied.wire).toContain('Namespace access denied');
      const csrf = await rawRequest(
        path,
        'POST',
        { ...identity('admin'), 'x-csrf-token': '' },
        '{}',
      );
      expect(csrf.status).toBe(403);
      expect(csrf.wire).toContain('CSRF validation failed');
      const globalAdmin = identity('admin');
      delete globalAdmin['x-ferrum-namespaces'];
      const unrestricted = await rawRequest(path, 'GET', globalAdmin);
      expect(unrestricted.status).toBe(403);
      expect(unrestricted.wire).toContain('FERRUM_BFF_CREDENTIAL_READ_DENIED');
    }
    for (const id of ['a%2Fb', 'a%5Cb', '%2520', '..', '%7f']) {
      const unsafe = await rawRequest(
        `/api/proxy/consumers/${id}/verification`, 'GET', identity('admin'),
      );
      expect(unsafe.status).toBe(400);
      expect(unsafe.wire).toContain('FERRUM_BFF_UNSAFE_PATH');
    }
    expect(arrivals).toHaveLength(beforeArrivals);
    expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
    expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
  });

  it('refuses ambiguous snapshot paths before signing or contacting upstream', async () => {
    const beforeArrivals = arrivals.length;
    const beforeTokens = vi.mocked(generateToken).mock.calls.length;
    const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
    for (const path of [
      '//deployment-snapshot',
      '/deployment-snapshot//',
      '/./deployment-snapshot',
      '/other/../deployment-snapshot',
      '/%2564eployment-snapshot',
      '/deployment-snapshot%2f',
      '/deployment-snapshot%5c',
      '/deployment-snapshot%00',
      '/deployment-snapshot%7f',
    ]) {
      const response = await rawRequest(`/api/proxy${path}`, 'GET', identity('admin'));
      expect(response.status, path).toBe(400);
      expect(response.wire).toContain('FERRUM_BFF_UNSAFE_PATH');
      expect(arrivals).toHaveLength(beforeArrivals);
      expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
      expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
    }
  });

  it('rejects malformed snapshot escapes without signing or contacting upstream', async () => {
    const beforeArrivals = arrivals.length;
    const beforeTokens = vi.mocked(generateToken).mock.calls.length;
    const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
    for (const path of [
      '/%zzdeployment-snapshot',
      '/deployment-snapshot%',
      '/%c0%afdeployment-snapshot',
    ]) {
      const response = await rawRequest(`/api/proxy${path}`, 'GET', identity('admin'));
      // The router may reject malformed wire escapes before onRequest runs.
      expect(response.status, path).toBe(400);
      expect(arrivals).toHaveLength(beforeArrivals);
      expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
      expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
    }
  });

  it('forwards masked consumer reads and ignores verification text in queries', async () => {
    for (const path of [
      '/consumers',
      '/consumers/consumer-1',
      '/%63onsumers/%63onsumer-1/',
      '/consumers/a%3Fb%23c?note=/consumers/other/verification',
      '/consumers/deployment-snapshot?note=/deployment-snapshot',
    ]) {
      const beforeTokens = vi.mocked(generateToken).mock.calls.length;
      const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
      const response = await rawRequest(`/api/proxy${path}`, 'GET', identity('admin'));
      expect(response.status).toBe(200);
      expect(response.wire).toContain('[REDACTED]');
      expect(response.wire).toContain('consumer-1');
      expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens + 1);
      expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches + 1);
      expect(decodeJwt(arrivals.at(-1)!.token)).toMatchObject({ role: 'admin', ns: 'tenant-a' });
    }
  });

  it('forwards backups, masked exports, and unrelated snapshot text unchanged', async () => {
    for (const path of [
      '/backup?note=/deployment-snapshot',
      '/config/export?note=%2Fdeployment-snapshot',
      '/proxies/deployment-snapshot',
      '/deployment-snapshot/extra',
      '/deployment-snapshots',
      '/admin/deployment-snapshot',
    ]) {
      const beforeArrivals = arrivals.length;
      const beforeTokens = vi.mocked(generateToken).mock.calls.length;
      const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
      const response = await rawRequest(`/api/proxy${path}`, 'GET', identity('admin'));
      expect(response.status, path).toBe(200);
      expect(arrivals).toHaveLength(beforeArrivals + 1);
      expect(arrivals.at(-1)).toMatchObject({ url: path, method: 'GET', namespace: 'tenant-a' });
      expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens + 1);
      expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches + 1);
    }
  });

  it('relays conditional snapshot 507s unchanged and releases every capacity permit', async () => {
    const tag = '"0123456789abcdef0123456789abcdef"';
    const routes: Array<[string, string, Record<string, string>, string]> = [
      ['GET', '/backup?conditional=true', {}, ''],
      ['POST', '/restore?confirm=true', { 'if-match': tag }, '{}'],
      [
        'DELETE',
        '/proxies/proxy-1?conditional=true&cleanup_orphaned_upstream=false',
        { 'if-match': tag },
        '',
      ],
      ['PUT', '/api-specs/spec-1?conditional=true', { 'if-match': tag }, '{}'],
    ];
    // More attempts than the per-principal long-read (8) and large-upload (2)
    // pools hold, so a leaked permit would surface as a 429.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const [method, path, headers, body] of routes) {
        const beforeArrivals = arrivals.length;
        const beforeTokens = vi.mocked(generateToken).mock.calls.length;
        const response = await rawRequest(
          `/api/proxy${path}`, method, { ...identity('admin'), ...headers }, body,
        );
        expect(response.status, `${method} ${path}`).toBe(507);
        expect(response.wire).toContain(SNAPSHOT_TOO_LARGE);
        expect(response.wire).not.toContain('FERRUM_BFF_');
        expect(arrivals).toHaveLength(beforeArrivals + 1);
        expect(arrivals.at(-1)).toMatchObject({ url: path, method, namespace: 'tenant-a' });
        expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens + 1);
      }
    }
    const backup = await rawRequest('/api/proxy/backup', 'GET', identity('admin'));
    expect(backup.status).toBe(200);
    const restore = await rawRequest(
      '/api/proxy/restore?confirm=true', 'POST', identity('admin'), '{}',
    );
    expect(restore.status).toBe(200);
  }, 15_000);

  it('denies snapshot writes before admission even when the upload pool is full', async () => {
    const pending: Array<ReturnType<typeof rawRequest>> = [];
    try {
      // These ordinary-body routes wait for their response, keeping all eight
      // configured upload permits held without changing any pool or deadline.
      for (let index = 0; index < 8; index += 1) {
        const ready = once(signals, 'held', { signal: AbortSignal.timeout(2500) });
        pending.push(
          rawRequest(
            `/api/proxy/admin/tls/acme/orders/order-${index}/finalize?hold=1`,
            'POST',
            identity('admin'),
            '{}',
          ),
        );
        await ready;
      }
      const beforeArrivals = arrivals.length;
      const beforeTokens = vi.mocked(generateToken).mock.calls.length;
      const beforeFetches = vi.mocked(upstreamFetch).mock.calls.length;
      const full = await rawRequest('/api/proxy/proxies', 'POST', identity('admin'), '{}');
      expect(full.status).toBe(429);
      expect(full.wire).toContain('FERRUM_BFF_UPLOAD_CAPACITY');
      const denied = await rawRequest(
        '/api/proxy/%64eployment-snapshot/?conditional=true',
        'PUT',
        identity('admin'),
        '{}',
      );
      expect(denied.status).toBe(403);
      expect(denied.wire).toContain('FERRUM_BFF_CREDENTIAL_READ_DENIED');
      expect(arrivals).toHaveLength(beforeArrivals);
      expect(vi.mocked(generateToken).mock.calls).toHaveLength(beforeTokens);
      expect(vi.mocked(upstreamFetch).mock.calls).toHaveLength(beforeFetches);
    } finally {
      for (const response of held.splice(0)) response.end('{}');
      await Promise.all(pending);
    }
    const released = await rawRequest('/api/proxy/proxies', 'POST', identity('admin'), '{}');
    expect(released.status).toBe(200);
  });

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
