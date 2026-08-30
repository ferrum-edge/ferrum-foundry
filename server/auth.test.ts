import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BFF_TOKEN = 'development-bff-token-is-long-enough-123';
const ENV = {
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'test-signing-secret-is-long-enough-123',
  FERRUM_BFF_AUTH_TOKEN: BFF_TOKEN,
  FERRUM_AUTH_MODE: 'static',
  FERRUM_SECURE_COOKIES: 'false',
};
const snapshot: Record<string, string | undefined> = {};

let authPlugin: typeof import('./auth.js').authPlugin;
let requireAdminAuth: typeof import('./auth.js').requireAdminAuth;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  const auth = await import('./auth.js');
  authPlugin = auth.authPlugin;
  requireAdminAuth = auth.requireAdminAuth;
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
  app.get('/protected', { onRequest: requireAdminAuth }, async (request) => ({
    principal: request.authPrincipal,
  }));
  app.post('/protected', { onRequest: requireAdminAuth }, async () => ({ ok: true }));
  return app;
}

async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token: BFF_TOKEN },
  });
  const body = response.json() as { csrfToken: string };
  const cookieHeader = response.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
  return { response, body, cookieHeader };
}

describe('static development sessions', () => {
  it('does not accept the deployment token as a reusable bearer credential', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${BFF_TOKEN}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['x-ferrum-auth-layer']).toBe('bff');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed JSON before parsing when an early auth hook protects the route', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/protected',
        headers: { 'content-type': 'application/json' },
        payload: '{ malformed',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('exchanges the token once for an HttpOnly SameSite session', async () => {
    const app = await buildApp();
    try {
      const { response } = await login(app);
      expect(response.statusCode).toBe(200);
      const setCookies = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'].join('; ')
        : response.headers['set-cookie'];
      expect(setCookies).toContain('ferrum-foundry-session=');
      expect(setCookies).toContain('HttpOnly');
      expect(setCookies).toContain('SameSite=Strict');
    } finally {
      await app.close();
    }
  });

  it('attaches the static role and exact namespace grants to the session principal', async () => {
    const app = await buildApp();
    try {
      const { cookieHeader } = await login(app);
      const response = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { cookie: cookieHeader },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().principal).toMatchObject({
        subject: 'ferrum-foundry-static',
        role: 'admin',
        authMode: 'static',
      });
    } finally {
      await app.close();
    }
  });

  it('requires the session-bound CSRF token for mutations', async () => {
    const app = await buildApp();
    try {
      const { body, cookieHeader } = await login(app);
      const missing = await app.inject({ method: 'POST', url: '/protected', headers: { cookie: cookieHeader } });
      expect(missing.statusCode).toBe(403);

      const accepted = await app.inject({
        method: 'POST',
        url: '/protected',
        headers: { cookie: cookieHeader, 'x-csrf-token': body.csrfToken },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('revokes the server-side session on logout', async () => {
    const app = await buildApp();
    try {
      const { body, cookieHeader } = await login(app);
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: cookieHeader, 'x-csrf-token': body.csrfToken },
      });
      expect(logout.statusCode).toBe(200);
      const after = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: cookieHeader } });
      expect(after.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('expires a server-side session without a process restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = await buildApp();
    try {
      const { cookieHeader } = await login(app);
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
      const response = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: cookieHeader } });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });

  it('rejects an incorrect login token without disclosing why', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token: 'wrong-token-that-is-also-long-enough' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });
});
