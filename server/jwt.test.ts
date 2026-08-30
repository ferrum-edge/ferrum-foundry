import { decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from './auth-types.js';
import type { Config } from './config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    adminUrl: 'http://127.0.0.1:9000',
    initialAdminOrigin: 'http://127.0.0.1:9000',
    adminAllowedOrigins: [],
    adminAllowedCidrs: [],
    jwtSecret: 'unit-test-signing-secret-is-long-enough',
    jwtIssuer: 'ferrum-foundry-tests',
    jwtTtl: 600,
    jwtMaxTtl: 3600,
    jwtRole: 'admin',
    jwtAudience: undefined,
    jwtNamespaces: undefined,
    tlsCaPath: undefined,
    tlsCaRoot: undefined,
    tlsVerify: true,
    connectTimeout: 5000,
    readTimeout: 60000,
    writeTimeout: 60000,
    port: 3001,
    maxLargeUploads: 2,
    allowRuntimeSettings: false,
    authMode: 'trusted-proxy',
    bffAuthToken: undefined,
    sessionTtl: 3600,
    trustedProxySecret: 'trusted-proxy-secret-is-long-enough',
    trustedProxyUserHeader: 'x-forwarded-user',
    trustedProxyRoleHeader: 'x-ferrum-role',
    trustedProxyNamespacesHeader: 'x-ferrum-namespaces',
    authLoginUrl: undefined,
    authLogoutUrl: undefined,
    secureCookies: true,
    enableHsts: false,
    ...overrides,
  };
}

function makePrincipal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    subject: 'alice@example.test',
    displayName: 'Alice',
    role: 'operator',
    namespaces: ['tenant-a', 'tenant-b'],
    authMode: 'trusted-proxy',
    ...overrides,
  };
}

async function verify(token: string, config: Config): Promise<JWTPayload> {
  return (await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {
    issuer: config.jwtIssuer,
    ...(config.jwtAudience && { audience: config.jwtAudience }),
  })).payload;
}

async function loadModule(): Promise<typeof import('./jwt.js')> {
  vi.resetModules();
  return import('./jwt.js');
}

describe('generateToken', () => {
  beforeEach(() => vi.resetModules());

  it('emits every claim required by the Ferrum Edge contract', async () => {
    const { generateToken } = await loadModule();
    const config = makeConfig({ jwtAudience: ['edge-admin', 'edge-ops'] });
    const token = await generateToken(config, makePrincipal());
    const payload = await verify(token, config);

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256' });
    expect(payload).toMatchObject({
      iss: config.jwtIssuer,
      sub: 'alice@example.test',
      role: 'operator',
      ns: ['tenant-a', 'tenant-b'],
      aud: ['edge-admin', 'edge-ops'],
    });
    for (const claim of ['exp', 'iat', 'nbf', 'jti']) expect(payload[claim]).toBeDefined();
  });

  it('uses a scalar namespace claim for one exact grant and omits optional claims when absent', async () => {
    const { generateToken } = await loadModule();
    const config = makeConfig();
    const payload = await verify(
      await generateToken(config, makePrincipal({ namespaces: ['tenant-a'] })),
      config,
    );
    expect(payload.ns).toBe('tenant-a');
    expect(payload.aud).toBeUndefined();
  });

  it('sets a positive bounded lifetime with aligned issued/not-before timestamps', async () => {
    const { generateToken } = await loadModule();
    const config = makeConfig({ jwtTtl: 300 });
    const payload = await verify(await generateToken(config, makePrincipal()), config);
    expect(payload.nbf).toBe(payload.iat);
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
  });

  it('reuses a token only when every signing input and principal claim matches', async () => {
    const { generateToken } = await loadModule();
    const config = makeConfig();
    const principal = makePrincipal();
    const first = await generateToken(config, principal);
    expect(await generateToken(config, principal)).toBe(first);
    expect(await generateToken(config, makePrincipal({ role: 'viewer' }))).not.toBe(first);
    expect(await generateToken(config, makePrincipal({ namespaces: ['tenant-c'] }))).not.toBe(first);
    expect(await generateToken({ ...config, adminUrl: 'https://other-gateway.test' }, principal)).not.toBe(first);
    expect(await generateToken({ ...config, jwtIssuer: 'changed' }, principal)).not.toBe(first);
    expect(await generateToken({ ...config, jwtTtl: 300 }, principal)).not.toBe(first);
    expect(await generateToken({ ...config, jwtAudience: 'other-admin-api' }, principal)).not.toBe(first);
    expect(await generateToken({ ...config, jwtSecret: 'another-signing-secret-that-is-long-enough' }, principal)).not.toBe(first);
  });

  it('attributes downstream activity to the authenticated actor', async () => {
    const { generateToken } = await loadModule();
    const config = makeConfig();
    const alice = await generateToken(config, makePrincipal({ subject: 'alice@example.test' }));
    const bob = await generateToken(config, makePrincipal({ subject: 'bob@example.test' }));
    expect((await verify(alice, config)).sub).toBe('alice@example.test');
    expect((await verify(bob, config)).sub).toBe('bob@example.test');
    expect(bob).not.toBe(alice);
  });
});
