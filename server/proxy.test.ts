import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BFF_TOKEN = 'proxy-test-bff-token-is-long-enough-123';
const JWT_SECRET = 'proxy-test-jwt-secret-is-long-enough-123';
const snapshot: Record<string, string | undefined> = {};
const observed: Array<{
  url: string;
  body: string;
  authorization?: string;
  acceptEncoding?: string;
}> = [];
const GZIP_RESPONSE = JSON.stringify({ ok: true, payload: 'x'.repeat(4096) });

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function gatewayHandler(request: IncomingMessage, response: ServerResponse): void {
  void (async () => {
    observed.push({
      url: request.url ?? '',
      body: await readBody(request),
      authorization: request.headers.authorization,
      acceptEncoding: request.headers['accept-encoding'],
    });
    if (request.url?.startsWith('/slow-headers')) {
      setTimeout(() => response.end('{"ok":true}'), 250);
      return;
    }
    if (request.url?.startsWith('/restore')) {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end('{"restored":true}');
      }, 250);
      return;
    }
    if (request.url?.startsWith('/unauthorized')) {
      response.statusCode = 401;
      response.end('{"error":"bad gateway jwt"}');
      return;
    }
    if (request.url?.startsWith('/gzip')) {
      const compressed = gzipSync(GZIP_RESPONSE);
      response.setHeader('content-type', 'application/json');
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('content-length', String(compressed.length));
      response.end(compressed);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.setHeader('etag', '"fixture"');
    response.setHeader('x-ferrum-config-cursor', '7:42');
    response.setHeader('x-data-source', 'cached');
    response.setHeader('location', '/resources/fixture');
    response.setHeader('set-cookie', 'upstream-secret=must-not-pass');
    response.end('{"ok":true}');
  })().catch(() => response.destroy());
}

const gateway = createServer(gatewayHandler);
let app: FastifyInstance;
let sessionHeaders: Record<string, string>;

beforeAll(async () => {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const port = (gateway.address() as AddressInfo).port;
  const env = {
    FERRUM_ADMIN_URL: `http://127.0.0.1:${port}`,
    FERRUM_JWT_SECRET: JWT_SECRET,
    FERRUM_BFF_AUTH_TOKEN: BFF_TOKEN,
    FERRUM_SECURE_COOKIES: 'false',
    FERRUM_READ_TIMEOUT: '100',
    FERRUM_WRITE_TIMEOUT: '100',
  };
  for (const [key, value] of Object.entries(env)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token: BFF_TOKEN },
  });
  const { csrfToken } = login.json() as { csrfToken: string };
  sessionHeaders = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': csrfToken,
  };
});

async function slowStreamingUpload(path: string): Promise<{ statusCode: number; body: string }> {
  const port = (app.server.address() as AddressInfo).port;
  let request: ReturnType<typeof httpRequest>;
  const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { ...sessionHeaders, 'content-type': 'application/octet-stream' },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({
        statusCode: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
  });

  request!.write('first');
  await new Promise((resolve) => setTimeout(resolve, 70));
  request!.write('second');
  await new Promise((resolve) => setTimeout(resolve, 70));
  request!.end('third');
  return response;
}

afterAll(async () => {
  await app.close();
  gateway.close();
  await once(gateway, 'close');
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('streaming gateway proxy', () => {
  it('separates liveness from authenticated downstream readiness', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok', version: '0.1.0' });

    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ready: true,
      components: { bff: { status: 'ok' }, gateway: { status: 'ok' } },
    });
    expect(observed.some(({ url }) => url === '/namespaces?offset=0&limit=1')).toBe(true);
  });

  it('applies baseline browser hardening headers to API responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('authenticates before parsing malformed JSON', async () => {
    const before = observed.length;
    const response = await app.inject({
      method: 'POST',
      url: '/api/proxy/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ malformed',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
    expect(observed).toHaveLength(before);
  });

  it('enforces a small default streaming body limit without buffering the request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/proxy/echo',
      headers: { ...sessionHeaders, 'content-type': 'text/plain' },
      payload: 'x'.repeat(2 * 1024 * 1024 + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('FERRUM_BFF_BODY_LIMIT');
  });

  it('forwards exact request bytes with attributable contract-compliant JWT claims', async () => {
    const raw = '{"name":"unchanged formatting","count":2}';
    const response = await app.inject({
      method: 'POST',
      url: '/api/proxy/echo?apply=async',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    const request = observed.at(-1);
    expect(request?.url).toBe('/echo?apply=async');
    expect(request?.body).toBe(raw);
    const token = request?.authorization?.replace(/^Bearer /, '');
    expect(token).toBeTruthy();
    expect(decodeJwt(token as string)).toMatchObject({
      sub: 'ferrum-foundry-static',
      role: 'admin',
    });
  });

  it('preserves reviewed response metadata while stripping upstream cookies', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy/echo',
      headers: sessionHeaders,
    });
    expect(response.headers.etag).toBe('"fixture"');
    expect(response.headers['x-ferrum-config-cursor']).toBe('7:42');
    expect(response.headers['x-data-source']).toBe('cached');
    expect(response.headers.location).toBe('/api/proxy/resources/fixture');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('streams a decoded upstream response without forwarding its compressed length', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy/gzip',
      headers: sessionHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(GZIP_RESPONSE);
    expect(observed.at(-1)?.acceptEncoding).toBe('identity');
  });

  it('distinguishes an upstream gateway 401 from a BFF session failure', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy/unauthorized',
      headers: sessionHeaders,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['x-ferrum-auth-layer']).toBe('gateway');
  });

  it('returns a stable timeout code when response headers exceed the normal deadline', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy/slow-headers',
      headers: sessionHeaders,
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ code: 'FERRUM_BFF_TIMEOUT', phase: 'response' });
  });

  it('uses the explicit long-running restore policy instead of the normal read timeout', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/proxy/restore',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      payload: '{"version":1}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ restored: true });
  });

  it('starts the response deadline after a progressing upload completes', async () => {
    const response = await slowStreamingUpload('/api/proxy/api-specs');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(observed.at(-1)?.body).toBe('firstsecondthird');
  });

  it('bounds concurrent large uploads and provides retry guidance', async () => {
    const request = () => app.inject({
      method: 'POST',
      url: '/api/proxy/restore',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      payload: '{"version":1}',
    });
    const responses = await Promise.all([request(), request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200, 429]);
    const rejected = responses.find((response) => response.statusCode === 429);
    expect(rejected?.headers['retry-after']).toBe('1');
  });
});
