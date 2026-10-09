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

async function setup(
  mode: 'static' | 'trusted-proxy',
  // Static mode requires an explicit scope; `*` is its every-namespace grant.
  staticGrants: string | undefined = mode === 'static' ? '*' : undefined,
  logLines?: string[],
  // The trusted admin is unrestricted unless the identity proxy sends grants.
  trustedGrants?: string,
) {
  vi.stubEnv('FERRUM_AUTH_MODE', mode);
  // Always set, so a setup never inherits a scope from the shell.
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
    ...(trustedGrants === undefined ? {} : { 'x-ferrum-namespaces': trustedGrants }),
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

  it('refuses a runtime remote adminUrl switch when TLS verification is disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FERRUM_TLS_VERIFY', 'false');
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_ORIGINS', 'https://gateway.example');
    const { app, headers } = await setup('trusted-proxy');
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { adminUrl: 'https://gateway.example' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('FERRUM_BFF_INVALID_SETTINGS');
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(after.json()).toEqual(before.json());
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

  it('ignores empty entries in a grant list', async () => {
    const { app, headers } = await setup('static');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-b', '', ' '] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().jwtNamespaces).toEqual(['tenant-b']);
  });

  it.each([
    { jwtIssuer: 'must-not-apply' },
    { jwtNamespaces: ['tenant-a'] },
    { jwtNamespaces: ['tenant-b'] },
    { jwtNamespaces: ['*'] },
    { jwtNamespaces: ['tenant-a', 'tenant-c'] },
    { jwtNamespaces: [] },
    { jwtNamespaces: 'tenant-a' },
    { adminUrl: 'http://127.0.0.1:9000' },
    { unsupported: true },
  ])('refuses every change from a static session holding namespace grants: %j', async (update) => {
    const { app, headers } = await setup('static', 'tenant-a,tenant-b');
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(before.json().jwtNamespaces).toEqual(['tenant-a', 'tenant-b']);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply', ...update },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'Namespace-scoped sessions cannot change BFF settings',
      code: 'FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED',
    });
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(after.json()).toEqual(before.json());
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a', 'tenant-b']);
  });

  it.each([
    { jwtAudience: 'edge-admin' },
    { jwtIssuer: 'must-not-apply' },
    { jwtNamespaces: ['tenant-a'] },
  ])('refuses every change from a trusted admin holding namespace grants: %j', async (update) => {
    const { app, headers } = await setup('trusted-proxy', undefined, undefined, 'tenant-a');
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(before.statusCode).toBe(200);
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: update });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED');
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(after.json()).toEqual(before.json());
  });

  it('refuses a scoped session before the runtime-settings gate', async () => {
    vi.stubEnv('FERRUM_ALLOW_RUNTIME_SETTINGS', 'false');
    const { app, headers } = await setup('static', 'tenant-a');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtIssuer: 'must-not-apply' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED');
  });

  it('logs a refused scoped change with the actor and nothing from the request', async () => {
    const logLines: string[] = [];
    const { app, headers } = await setup('static', 'tenant-a', logLines);
    const response = await app.inject({
      method: 'PUT', url: '/api/settings', headers,
      payload: { jwtNamespaces: ['tenant-a', 'tenant-z'], jwtIssuer: 'issuer-from-body' },
    });
    expect(response.statusCode).toBe(403);
    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusal = entries.find((entry) => entry.msg === 'Namespace-scoped settings change refused');
    expect(refusal).toMatchObject({ level: 40, actor: 'ferrum-foundry-static' });
    expect(logLines.join('\n')).not.toContain('issuer-from-body');
    expect(logLines.join('\n')).not.toContain(BFF_TOKEN);
    expect(logLines.join('\n')).not.toContain(headers['x-csrf-token']);
  });

  it('lets only an unrestricted session change settings once the defaults are scoped', async () => {
    const { app, headers: unrestricted } = await setup('static');
    const narrow = await app.inject({
      method: 'PUT', url: '/api/settings', headers: unrestricted,
      payload: { jwtNamespaces: ['tenant-a'] },
    });
    expect(narrow.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.json().principal.namespaces).toEqual(['tenant-a']);
    const scoped = {
      cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-csrf-token': login.json().csrfToken as string,
    };

    // The scoped login can neither restore the wider defaults nor change an
    // unrelated setting; the session that set them still can.
    for (const payload of [{ jwtNamespaces: ['*'] }, { jwtIssuer: 'issuer-2' }]) {
      const refused = await app.inject({ method: 'PUT', url: '/api/settings', headers: scoped, payload });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED');
    }
    const restore = await app.inject({
      method: 'PUT', url: '/api/settings', headers: unrestricted,
      payload: { jwtIssuer: 'issuer-2', jwtNamespaces: ['*'] },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ jwtIssuer: 'issuer-2', jwtNamespaces: ['*'] });
  });

  it('grants every namespace only through the explicit wildcard', async () => {
    // FERRUM_JWT_NAMESPACES=* leaves the static principal unrestricted, which
    // the settings response reports as the wildcard.
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
