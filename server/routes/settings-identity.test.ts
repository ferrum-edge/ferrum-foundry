import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROXY_SECRET = 'settings-identity-proxy-test-secret-long-enough';
const BFF_TOKEN = 'settings-identity-static-test-token-long-enough';
let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', 'http://127.0.0.1:9000');
  vi.stubEnv('FERRUM_JWT_SECRET', 'settings-identity-signing-test-secret-long-enough');
  vi.stubEnv('FERRUM_ALLOW_RUNTIME_SETTINGS', 'true');
  vi.stubEnv('FERRUM_ADMIN_ALLOWED_ORIGINS', 'http://127.0.0.1:9000');
  vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function setup(mode: 'static' | 'trusted-proxy') {
  vi.stubEnv('FERRUM_AUTH_MODE', mode);
  vi.stubEnv('FERRUM_BFF_AUTH_TOKEN', BFF_TOKEN);
  vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', PROXY_SECRET);
  const { authPlugin } = await import('../auth.js');
  const { default: settingsPlugin } = await import('./settings.js');
  app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(settingsPlugin);
  const identityHeaders: Record<string, string> = mode === 'trusted-proxy' ? {
    'x-ferrum-auth-secret': PROXY_SECRET,
    'x-forwarded-user': 'settings-admin@example.test',
    'x-ferrum-role': 'admin',
    'x-ferrum-namespaces': 'tenant-a',
  } : {};
  const session = mode === 'trusted-proxy'
    ? await app.inject({ method: 'GET', url: '/api/auth/session', headers: identityHeaders })
    : await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
  expect(session.statusCode).toBe(200);
  return {
    app,
    headers: {
      ...identityHeaders,
      cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-csrf-token': session.json().csrfToken as string,
    },
  };
}

describe('settings identity authority', () => {
  it.each([{ jwtRole: 'viewer' }, { jwtNamespaces: ['tenant-b'] }])(
    'rejects proxy-managed defaults without applying other fields: %j',
    async (identityUpdate) => {
      const { app, headers } = await setup('trusted-proxy');
      const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
      expect(before.json().authMode).toBe('trusted-proxy');
      const response = await app.inject({
        method: 'PUT', url: '/api/settings', headers,
        payload: { jwtIssuer: 'must-not-apply', ...identityUpdate },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('FERRUM_BFF_PROXY_MANAGED_IDENTITY');
      const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
      expect(after.json()).toEqual(before.json());
    },
  );

  it('allows independent signing settings in trusted-proxy mode', async () => {
    const { app, headers } = await setup('trusted-proxy');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtAudience: 'edge-admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authMode: 'trusted-proxy', jwtAudience: 'edge-admin' });
  });

  it('uses updated static defaults for subsequent logins', async () => {
    const { app, headers } = await setup('static');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtRole: 'viewer', jwtNamespaces: ['tenant-b'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authMode: 'static', jwtRole: 'viewer', jwtNamespaces: ['tenant-b'] });
    const existing = await app.inject({ method: 'GET', url: '/api/auth/session', headers });
    expect(existing.json().principal.role).toBe('admin');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.statusCode).toBe(200);
    expect(login.json().principal).toMatchObject({ role: 'viewer', namespaces: ['tenant-b'] });
  });
});
