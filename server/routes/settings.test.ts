import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BFF_TOKEN = 'settings-test-bff-token-is-long-enough';
const JWT_SECRET = 'settings-test-jwt-secret-is-long-enough';
const ENV = {
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_ADMIN_ALLOWED_ORIGINS: 'https://gateway.example',
  FERRUM_ALLOW_RUNTIME_SETTINGS: 'true',
  FERRUM_JWT_SECRET: JWT_SECRET,
  FERRUM_BFF_AUTH_TOKEN: BFF_TOKEN,
  FERRUM_SECURE_COOKIES: 'false',
};
const snapshot: Record<string, string | undefined> = {};

let authPlugin: typeof import('../auth.js').authPlugin;
let settingsPlugin: typeof import('./settings.js').default;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  authPlugin = (await import('../auth.js')).authPlugin;
  settingsPlugin = (await import('./settings.js')).default;
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
  await app.register(settingsPlugin);
  return app;
}

async function authenticatedHeaders(app: FastifyInstance): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token: BFF_TOKEN },
  });
  const { csrfToken } = login.json() as { csrfToken: string };
  return {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': csrfToken,
  };
}

describe('settings routes', () => {
  it('requires an authenticated session', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['x-ferrum-auth-layer']).toBe('bff');
    } finally {
      await app.close();
    }
  });

  it('omits the signing secret and local CA path', async () => {
    const app = await buildApp();
    try {
      const headers = await authenticatedHeaders(app);
      const response = await app.inject({ method: 'GET', url: '/api/settings', headers });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('jwtSecret');
      expect(body).not.toHaveProperty('tlsCaPath');
      expect(JSON.stringify(body)).not.toContain(JWT_SECRET);
      expect(body.runtimeSettingsEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('requires CSRF validation before parsing a settings mutation', async () => {
    const app = await buildApp();
    try {
      const headers = await authenticatedHeaders(app);
      delete headers['x-csrf-token'];
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { jwtIssuer: 'changed' },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported fields including jwtSecret', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: await authenticatedHeaders(app),
        payload: { jwtSecret: 'attacker-controlled-secret' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/unsupported/);
    } finally {
      await app.close();
    }
  });

  it('accepts a validated allowlisted origin and bounded signing settings', async () => {
    const app = await buildApp();
    try {
      const headers = await authenticatedHeaders(app);
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: {
          adminUrl: 'https://gateway.example',
          jwtIssuer: 'updated-issuer',
          jwtTtl: 600,
          jwtRole: 'admin',
          jwtAudience: 'edge-admin',
          jwtNamespaces: ['tenant-a'],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        adminUrl: 'https://gateway.example',
        jwtIssuer: 'updated-issuer',
        jwtTtl: 600,
        jwtRole: 'admin',
        jwtAudience: 'edge-admin',
        jwtNamespaces: ['tenant-a'],
      });
    } finally {
      await app.close();
    }
  });

  it('returns a redacted validation error for disallowed destinations', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: await authenticatedHeaders(app),
        payload: { adminUrl: 'http://169.254.169.254' },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).not.toContain('169.254.169.254');
    } finally {
      await app.close();
    }
  });
});
