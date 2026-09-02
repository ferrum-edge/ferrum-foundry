import cookie from '@fastify/cookie';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const PROXY_SECRET = 'trusted-proxy-shared-secret-is-long-enough';
const ENV = {
  NODE_ENV: 'production',
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'test-signing-secret-is-long-enough-123',
  FERRUM_AUTH_MODE: 'trusted-proxy',
  FERRUM_TRUSTED_PROXY_SECRET: PROXY_SECRET,
  FERRUM_SECURE_COOKIES: 'false',
};
const snapshot: Record<string, string | undefined> = {};

let authPlugin: typeof import('./auth.js').authPlugin;
let requireAdminAuth: typeof import('./auth.js').requireAdminAuth;
let requireRole: typeof import('./auth.js').requireRole;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  delete process.env.FERRUM_BFF_AUTH_TOKEN;
  vi.resetModules();
  const auth = await import('./auth.js');
  authPlugin = auth.authPlugin;
  requireAdminAuth = auth.requireAdminAuth;
  requireRole = auth.requireRole;
});

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin);
  app.get('/protected', { onRequest: requireAdminAuth }, async (request) => request.authPrincipal);
  app.post('/protected', { onRequest: requireAdminAuth }, async () => ({ ok: true }));
  app.get('/api/proxy/test', { onRequest: requireAdminAuth }, async () => ({ ok: true }));
  app.get('/api/proxy/admin/tls/inventory', { onRequest: requireAdminAuth }, async () => ({ ok: true }));
  app.get('/api/proxy/*', { onRequest: requireAdminAuth }, async () => ({ ok: true }));
  app.get('/admin-only', { onRequest: requireRole('admin') }, async () => ({ ok: true }));
  return app;
}

/** Builds an app from an independently imported auth module, i.e. a second replica. */
async function buildAppFrom(auth: typeof import('./auth.js')): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(auth.authPlugin);
  app.get('/protected', { onRequest: auth.requireAdminAuth }, async (request) => request.authPrincipal);
  app.post('/protected', { onRequest: auth.requireAdminAuth }, async () => ({ ok: true }));
  return app;
}

function cookieHeaderOf(response: { cookies: { name: string; value: string }[] }): string {
  return response.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
}

async function issueCsrf(
  app: FastifyInstance,
  headers: Record<string, string> = identityHeaders(),
): Promise<{ csrfToken: string; cookieHeader: string }> {
  const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers });
  return {
    csrfToken: (session.json() as { csrfToken: string }).csrfToken,
    cookieHeader: cookieHeaderOf(session),
  };
}

async function rawGet(
  app: FastifyInstance,
  path: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function identityHeaders(overrides: Record<string, string> = {}) {
  return {
    'x-ferrum-auth-secret': PROXY_SECRET,
    'x-forwarded-user': 'alice@example.test',
    'x-ferrum-role': 'viewer',
    'x-ferrum-namespaces': 'tenant-a,tenant-b',
    ...overrides,
  };
}

describe('trusted OIDC proxy authentication', () => {
  it('requires a trusted proxy proof and validated identity headers', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/protected' })).statusCode).toBe(401);
      const response = await app.inject({ method: 'GET', url: '/protected', headers: identityHeaders() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        subject: 'alice@example.test',
        role: 'viewer',
        namespaces: ['tenant-a', 'tenant-b'],
        authMode: 'trusted-proxy',
      });
    } finally {
      await app.close();
    }
  });

  it('requires explicit namespace grants for non-admin identities', async () => {
    const app = await buildApp();
    try {
      const headers = identityHeaders();
      delete (headers as Partial<typeof headers>)['x-ferrum-namespaces'];
      const response = await app.inject({ method: 'GET', url: '/protected', headers });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('requires a granted namespace on namespace-scoped gateway requests', async () => {
    const app = await buildApp();
    try {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/proxy/test',
        headers: identityHeaders(),
      });
      expect(missing.statusCode).toBe(403);

      const denied = await app.inject({
        method: 'GET',
        url: '/api/proxy/test',
        headers: identityHeaders({ 'x-ferrum-namespace': 'tenant-c' }),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: 'Namespace access denied' });

      const allowed = await app.inject({
        method: 'GET',
        url: '/api/proxy/test',
        headers: identityHeaders({ 'x-ferrum-namespace': 'tenant-a' }),
      });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does not apply tenant headers to BFF-local or documented fleet-global routes', async () => {
    const app = await buildApp();
    try {
      const local = await app.inject({ method: 'GET', url: '/protected', headers: identityHeaders() });
      const fleetGlobal = await app.inject({
        method: 'GET',
        url: '/api/proxy/admin/tls/inventory',
        headers: identityHeaders(),
      });
      expect(local.statusCode).toBe(200);
      expect(fleetGlobal.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does not let dot segments cross the fleet-global TLS authorization boundary', async () => {
    const app = await buildApp();
    try {
      for (const path of [
        '/api/proxy/admin/tls/../../test',
        '/api/proxy/admin/tls/%2e%2e/%2e%2e/test',
        '/api/proxy/admin/tls/%252e%252e/%252e%252e/test',
      ]) {
        const response = await rawGet(app, path, identityHeaders());
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body)).toEqual({ error: 'Namespace access denied' });
      }
    } finally {
      await app.close();
    }
  });

  it('uses the matched proxy route when the raw prefix is percent-encoded', async () => {
    const app = await buildApp();
    try {
      for (const path of ['/%61pi/proxy/test', '/api/pro%78y/test']) {
        const response = await rawGet(app, path, identityHeaders());
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body)).toEqual({ error: 'Namespace access denied' });
      }

      const fleetGlobal = await rawGet(app, '/%61pi/proxy/admin/tls/inventory', identityHeaders());
      expect(fleetGlobal.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('enforces BFF-local role requirements before privileged server settings', async () => {
    const app = await buildApp();
    try {
      const viewer = await app.inject({ method: 'GET', url: '/admin-only', headers: identityHeaders() });
      expect(viewer.statusCode).toBe(403);
      const admin = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: identityHeaders({ 'x-ferrum-role': 'admin' }),
      });
      expect(admin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('uses a non-secret double-submit CSRF value for trusted sessions', async () => {
    const app = await buildApp();
    try {
      const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identityHeaders() });
      const { csrfToken } = session.json() as { csrfToken: string };
      const cookieHeader = session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
      const response = await app.inject({
        method: 'POST',
        url: '/protected',
        headers: identityHeaders({ cookie: cookieHeader, 'x-csrf-token': csrfToken }),
      });
      expect(response.statusCode).toBe(200);
      expect(session.headers['set-cookie']).not.toContain('ferrum-foundry-session=');
    } finally {
      await app.close();
    }
  });

  it('reuses one bounded CSRF grant per trusted identity', async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identityHeaders() });
      const second = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identityHeaders() });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().csrfToken).toBe(first.json().csrfToken);
    } finally {
      await app.close();
    }
  });

  it('accepts a CSRF token minted by a different replica holding the same secret', async () => {
    const first = await buildApp();
    let issued: { csrfToken: string; cookieHeader: string };
    try {
      issued = await issueCsrf(first);
    } finally {
      await first.close();
    }

    // A fresh module graph has none of the first instance's in-process state,
    // exactly like a sibling pod behind the load balancer.
    vi.resetModules();
    const replica = await import('./auth.js');
    expect(replica.requireAdminAuth).not.toBe(requireAdminAuth);
    const second = await buildAppFrom(replica);
    try {
      const response = await second.inject({
        method: 'POST',
        url: '/protected',
        headers: identityHeaders({
          cookie: issued.cookieHeader,
          'x-csrf-token': issued.csrfToken,
        }),
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await second.close();
    }
  });

  it('binds a CSRF token to the subject the identity proxy asserted', async () => {
    const app = await buildApp();
    try {
      const { csrfToken, cookieHeader } = await issueCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/protected',
        headers: identityHeaders({
          'x-forwarded-user': 'mallory@example.test',
          cookie: cookieHeader,
          'x-csrf-token': csrfToken,
        }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'CSRF validation failed' });
    } finally {
      await app.close();
    }
  });

  it('rejects tampered and malformed CSRF tokens', async () => {
    const app = await buildApp();
    try {
      const { csrfToken } = await issueCsrf(app);
      const [encodedExpiry, mac] = csrfToken.split('.');
      const flipped = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
      const nonIntegerExpiry = Buffer.from('not-a-number', 'utf8').toString('base64url');

      const candidates = [
        `${encodedExpiry}.${flipped}`,
        `${encodedExpiry}${mac}`,
        `${nonIntegerExpiry}.${mac}`,
        `${encodedExpiry}.${mac}.${mac}`,
      ];
      for (const candidate of candidates) {
        const response = await app.inject({
          method: 'POST',
          url: '/protected',
          headers: identityHeaders({
            cookie: `ferrum-foundry-csrf=${candidate}`,
            'x-csrf-token': candidate,
          }),
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'CSRF validation failed' });
      }
    } finally {
      await app.close();
    }
  });

  it('rejects a CSRF token past its signed expiry', async () => {
    const previousTtl = process.env.FERRUM_SESSION_TTL;
    process.env.FERRUM_SESSION_TTL = '60';
    vi.resetModules();
    const shortTtl = await import('./auth.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const app = await buildAppFrom(shortTtl);
    try {
      const { csrfToken, cookieHeader } = await issueCsrf(app);
      const headers = identityHeaders({ cookie: cookieHeader, 'x-csrf-token': csrfToken });

      vi.setSystemTime(new Date('2026-03-01T00:00:30Z'));
      const live = await app.inject({ method: 'POST', url: '/protected', headers });
      expect(live.statusCode).toBe(200);

      vi.setSystemTime(new Date('2026-03-01T00:01:01Z'));
      const expired = await app.inject({ method: 'POST', url: '/protected', headers });
      expect(expired.statusCode).toBe(403);
      expect(expired.json()).toEqual({ error: 'CSRF validation failed' });
    } finally {
      await app.close();
      vi.useRealTimers();
      if (previousTtl === undefined) delete process.env.FERRUM_SESSION_TTL;
      else process.env.FERRUM_SESSION_TTL = previousTtl;
    }
  });

  it('keeps a fresh CSRF cookie stable and rotates it inside the final quarter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const app = await buildApp();
    try {
      const { csrfToken, cookieHeader } = await issueCsrf(app);
      const withCookie = identityHeaders({ cookie: cookieHeader });

      // Half of the 3600s default TTL elapsed: the open tab keeps its cookie.
      vi.setSystemTime(new Date('2026-03-01T00:30:00Z'));
      const reused = await app.inject({ method: 'GET', url: '/api/auth/session', headers: withCookie });
      expect(reused.json().csrfToken).toBe(csrfToken);

      // 80% elapsed, inside the final quarter: reissue before it can expire.
      vi.setSystemTime(new Date('2026-03-01T00:48:00Z'));
      const rotated = await app.inject({ method: 'GET', url: '/api/auth/session', headers: withCookie });
      expect(rotated.json().csrfToken).not.toBe(csrfToken);
      expect(rotated.cookies.map((entry) => entry.value)).toContain(rotated.json().csrfToken);
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });
});
