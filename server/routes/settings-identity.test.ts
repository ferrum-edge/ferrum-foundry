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

async function setup(mode: 'static' | 'trusted-proxy', staticGrants?: string, logLines?: string[]) {
  vi.stubEnv('FERRUM_AUTH_MODE', mode);
  // Always set, so an unscoped setup never inherits a scope from the shell.
  vi.stubEnv('FERRUM_JWT_NAMESPACES', staticGrants);
  vi.stubEnv('FERRUM_BFF_AUTH_TOKEN', BFF_TOKEN);
  vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', PROXY_SECRET);
  const { authPlugin } = await import('../auth.js');
  const { default: settingsPlugin } = await import('./settings.js');
  app = logLines
    ? Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { logLines.push(line); } } } })
    : Fastify();
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

  it('refuses an empty static grant list from a scoped session without applying other fields', async () => {
    const { app, headers } = await setup('static', 'tenant-a,tenant-b');
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(before.json().jwtNamespaces).toEqual(['tenant-a', 'tenant-b']);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply', jwtNamespaces: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('FERRUM_BFF_INVALID_SETTINGS');
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(after.json()).toEqual(before.json());
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a', 'tenant-b']);
  });

  it.each([
    { jwtNamespaces: [] },
    { jwtNamespaces: [''] },
    { jwtNamespaces: [' ', ','] },
    { jwtNamespaces: ['*', 'tenant-a'] },
    { jwtNamespaces: ['tenant a'] },
    { jwtNamespaces: 'tenant-a' },
    { jwtNamespaces: null },
  ])('refuses malformed static grants without applying other fields: %j', async (update) => {
    const { app, headers } = await setup('static');
    const narrowed = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-a'] },
    });
    expect(narrowed.statusCode).toBe(200);
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply', ...update },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('FERRUM_BFF_INVALID_SETTINGS');
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(after.json()).toEqual(before.json());
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a']);
  });

  it.each([
    { jwtNamespaces: ['*'] },
    { jwtNamespaces: ['tenant-c'] },
    { jwtNamespaces: ['tenant-a', 'tenant-c'] },
  ])('refuses a scoped session widening static grants: %j', async (update) => {
    const { app, headers } = await setup('static', 'tenant-a,tenant-b');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply', ...update },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FERRUM_BFF_NAMESPACE_GRANT_EXCEEDED');
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(settings.json()).toMatchObject({ jwtIssuer: 'ferrum-edge', jwtNamespaces: ['tenant-a', 'tenant-b'] });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a', 'tenant-b']);
  });

  it.each([
    { jwtNamespaces: 'tenant-a' },
    { jwtNamespaces: null },
    { jwtNamespaces: { tenant: 'tenant-a' } },
    { jwtNamespaces: ['tenant-a', 7] },
  ])('refuses a malformed grant list as a bad request, not a widening: %j', async (update) => {
    const logLines: string[] = [];
    const { app, headers } = await setup('static', 'tenant-a,tenant-b', logLines);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply', ...update },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('FERRUM_BFF_INVALID_SETTINGS');
    expect(logLines.join('\n')).not.toContain('Namespace grant widening refused');
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(settings.json()).toMatchObject({ jwtIssuer: 'ferrum-edge', jwtNamespaces: ['tenant-a', 'tenant-b'] });
  });

  it('logs a refused widening with the actor and the requested grants', async () => {
    const logLines: string[] = [];
    const { app, headers } = await setup('static', 'tenant-a', logLines);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-a', 'tenant-z'] },
    });
    expect(response.statusCode).toBe(403);
    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusal = entries.find((entry) => entry.msg === 'Namespace grant widening refused');
    expect(refusal).toMatchObject({
      level: 40,
      actor: 'ferrum-foundry-static',
      requested: ['tenant-a', 'tenant-z'],
    });
    expect(logLines.join('\n')).not.toContain(BFF_TOKEN);
    expect(logLines.join('\n')).not.toContain(headers['x-csrf-token']);
  });

  it('lets a session narrower than the defaults save settings that omit grants', async () => {
    const { app, headers: wide } = await setup('static', 'tenant-a,tenant-b');
    const narrow = await app.inject({
      method: 'PUT', url: '/api/settings', headers: wide,
      payload: { jwtNamespaces: ['tenant-a'] },
    });
    expect(narrow.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a']);
    const scoped = {
      cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-csrf-token': login.json().csrfToken as string,
    };
    const restore = await app.inject({
      method: 'PUT', url: '/api/settings', headers: wide,
      payload: { jwtNamespaces: ['tenant-a', 'tenant-b'] },
    });
    expect(restore.statusCode).toBe(200);

    // The defaults now grant more than the scoped session holds. Resubmitting
    // them would be a widening; omitting them leaves them unchanged.
    const resubmitted = await app.inject({
      method: 'PUT', url: '/api/settings', headers: scoped,
      payload: { jwtIssuer: 'issuer-2', jwtNamespaces: ['tenant-a', 'tenant-b'] },
    });
    expect(resubmitted.statusCode).toBe(403);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers: scoped,
      payload: { jwtIssuer: 'issuer-2', jwtRole: 'operator' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jwtIssuer: 'issuer-2', jwtRole: 'operator', jwtNamespaces: ['tenant-a', 'tenant-b'],
    });
  });

  it('ignores empty entries when checking a narrowing request', async () => {
    const { app, headers } = await setup('static', 'tenant-a,tenant-b');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-b', '', ' '] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().jwtNamespaces).toEqual(['tenant-b']);
  });

  it('lets a scoped session narrow static grants to ones it holds', async () => {
    const { app, headers } = await setup('static', 'tenant-a,tenant-b');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: [' tenant-b '] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().jwtNamespaces).toEqual(['tenant-b']);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-b']);
  });

  it('grants every namespace only through the explicit wildcard', async () => {
    // Unset FERRUM_JWT_NAMESPACES leaves the static principal unrestricted,
    // which the settings response reports as the wildcard.
    const { app, headers } = await setup('static');
    const initial = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(initial.json().jwtNamespaces).toEqual(['*']);
    const scoped = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-a'] },
    });
    expect(scoped.json().jwtNamespaces).toEqual(['tenant-a']);
    const widened = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['*'] },
    });
    expect(widened.statusCode).toBe(200);
    expect(widened.json().jwtNamespaces).toEqual(['*']);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal).not.toHaveProperty('namespaces');
  });
});
