import cookie from '@fastify/cookie';
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
  app.get('/admin-only', { onRequest: requireRole('admin') }, async () => ({ ok: true }));
  return app;
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
});
