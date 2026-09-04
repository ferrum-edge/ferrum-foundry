import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'NODE_ENV',
  'FERRUM_ADMIN_URL',
  'FERRUM_ADMIN_ALLOWED_ORIGINS',
  'FERRUM_ADMIN_ALLOWED_CIDRS',
  'FERRUM_ALLOW_RUNTIME_SETTINGS',
  'FERRUM_JWT_SECRET',
  'FERRUM_JWT_ISSUER',
  'FERRUM_JWT_TTL',
  'FERRUM_JWT_MAX_TTL',
  'FERRUM_JWT_ROLE',
  'FERRUM_JWT_AUDIENCE',
  'FERRUM_JWT_NAMESPACES',
  'FERRUM_AUTH_MODE',
  'FERRUM_AUTH_LOGIN_URL',
  'FERRUM_AUTH_LOGOUT_URL',
  'FERRUM_ALLOW_INSECURE_STATIC_AUTH',
  'FERRUM_BFF_AUTH_TOKEN',
  'FERRUM_TRUSTED_PROXY_SECRET',
  'FERRUM_TLS_CA_PATH',
  'FERRUM_TLS_CA_ROOT',
  'FERRUM_TLS_VERIFY',
  'FERRUM_CONNECT_TIMEOUT',
  'FERRUM_READ_TIMEOUT',
  'FERRUM_WRITE_TIMEOUT',
  'FERRUM_UPLOAD_TIMEOUT',
  'FERRUM_MAX_LARGE_UPLOADS',
  'FERRUM_MAX_ACTIVE_UPLOADS',
  'FERRUM_BIND_ADDRESS',
  'FERRUM_SHUTDOWN_TIMEOUT',
  'PORT',
] as const;

const snapshot: Record<string, string | undefined> = {};

function clearTestEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setValidEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.FERRUM_ADMIN_URL = 'http://127.0.0.1:9000';
  process.env.FERRUM_JWT_SECRET = 'j'.repeat(40);
  process.env.FERRUM_BFF_AUTH_TOKEN = 'b'.repeat(40);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadModule(): Promise<typeof import('./config.js')> {
  vi.resetModules();
  return import('./config.js');
}

describe('config', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires the gateway URL, signing secret, and static development token', async () => {
    setValidEnv({ FERRUM_ADMIN_URL: undefined });
    const missingUrl = await loadModule();
    expect(() => missingUrl.loadConfig()).toThrow(/FERRUM_ADMIN_URL/);

    setValidEnv({ FERRUM_JWT_SECRET: undefined });
    const missingSecret = await loadModule();
    expect(() => missingSecret.loadConfig()).toThrow(/FERRUM_JWT_SECRET/);

    setValidEnv({ FERRUM_BFF_AUTH_TOKEN: undefined });
    const missingToken = await loadModule();
    expect(() => missingToken.loadConfig()).toThrow(/FERRUM_BFF_AUTH_TOKEN/);
  });

  it('rejects gateway signing and static secrets shorter than 32 characters', async () => {
    setValidEnv({ FERRUM_JWT_SECRET: 'short' });
    const weakJwt = await loadModule();
    expect(() => weakJwt.loadConfig()).toThrow(/32/);

    setValidEnv({ FERRUM_BFF_AUTH_TOKEN: 'short' });
    const weakBff = await loadModule();
    expect(() => weakBff.loadConfig()).toThrow(/32/);
  });

  it('applies bounded launch-safe defaults', async () => {
    setValidEnv();
    const { loadConfig } = await loadModule();
    expect(loadConfig()).toMatchObject({
      adminUrl: 'http://127.0.0.1:9000',
      jwtIssuer: 'ferrum-edge',
      jwtTtl: 900,
      jwtMaxTtl: 3600,
      jwtRole: 'admin',
      jwtAudience: undefined,
      jwtNamespaces: undefined,
      tlsVerify: true,
      connectTimeout: 5000,
      readTimeout: 60000,
      writeTimeout: 60000,
      uploadTimeout: 300_000,
      maxLargeUploads: 2,
      maxActiveUploads: 32,
      port: 3001,
      bindAddress: '0.0.0.0',
      shutdownTimeout: 10_000,
      authMode: 'static',
      allowRuntimeSettings: false,
    });
  });

  it('accepts an explicit literal listening interface', async () => {
    for (const [address, expected] of [
      ['127.0.0.1', '127.0.0.1'],
      ['::1', '::1'],
      ['localhost', 'localhost'],
    ]) {
      clearTestEnv();
      setValidEnv({ FERRUM_BIND_ADDRESS: address });
      const { loadConfig } = await loadModule();
      expect(loadConfig().bindAddress).toBe(expected);
    }
  });

  it('rejects a listening interface that is not a literal address', async () => {
    for (const address of ['bff.internal', '0.0.0.0:3001', '10.0.0.256', '']) {
      clearTestEnv();
      setValidEnv({ FERRUM_BIND_ADDRESS: address });
      const { loadConfig } = await loadModule();
      if (address === '') {
        // An empty value is indistinguishable from an unset variable.
        expect(loadConfig().bindAddress).toBe('0.0.0.0');
      } else {
        expect(() => loadConfig()).toThrow(/FERRUM_BIND_ADDRESS must be an IP address or localhost/);
      }
    }
  });

  it('bounds the graceful shutdown deadline', async () => {
    setValidEnv({ FERRUM_SHUTDOWN_TIMEOUT: '30000' });
    const { loadConfig } = await loadModule();
    expect(loadConfig().shutdownTimeout).toBe(30_000);

    for (const value of ['999', '300001', 'soon']) {
      clearTestEnv();
      setValidEnv({ FERRUM_SHUTDOWN_TIMEOUT: value });
      const invalid = await loadModule();
      expect(() => invalid.loadConfig()).toThrow(/FERRUM_SHUTDOWN_TIMEOUT/);
    }
  });

  it('bounds the absolute upload deadline', async () => {
    setValidEnv({ FERRUM_UPLOAD_TIMEOUT: '90000' });
    const { loadConfig } = await loadModule();
    expect(loadConfig().uploadTimeout).toBe(90_000);

    for (const value of ['999', '3600001', 'never']) {
      clearTestEnv();
      setValidEnv({ FERRUM_UPLOAD_TIMEOUT: value });
      const invalid = await loadModule();
      expect(() => invalid.loadConfig()).toThrow(/FERRUM_UPLOAD_TIMEOUT/);
    }
  });

  it('bounds the global and large in-flight upload pools', async () => {
    setValidEnv({ FERRUM_MAX_ACTIVE_UPLOADS: '64', FERRUM_MAX_LARGE_UPLOADS: '8' });
    const { loadConfig } = await loadModule();
    expect(loadConfig()).toMatchObject({ maxActiveUploads: 64, maxLargeUploads: 8 });

    for (const value of ['0', '1025', 'many']) {
      clearTestEnv();
      setValidEnv({ FERRUM_MAX_ACTIVE_UPLOADS: value });
      const invalid = await loadModule();
      expect(() => invalid.loadConfig()).toThrow(/FERRUM_MAX_ACTIVE_UPLOADS/);
    }

    for (const value of ['0', '33']) {
      clearTestEnv();
      setValidEnv({ FERRUM_MAX_LARGE_UPLOADS: value });
      const invalid = await loadModule();
      expect(() => invalid.loadConfig()).toThrow(/FERRUM_MAX_LARGE_UPLOADS/);
    }
  });

  it('rejects a large-upload pool wider than the global in-flight upload pool', async () => {
    setValidEnv({ FERRUM_MAX_LARGE_UPLOADS: '8', FERRUM_MAX_ACTIVE_UPLOADS: '4' });
    const { loadConfig } = await loadModule();
    expect(() => loadConfig()).toThrow(/FERRUM_MAX_LARGE_UPLOADS must not exceed FERRUM_MAX_ACTIVE_UPLOADS/);
  });

  it('parses role, audience, and exact namespace claims', async () => {
    setValidEnv({
      FERRUM_JWT_ROLE: 'operator',
      FERRUM_JWT_AUDIENCE: 'admin-a, admin-b',
      FERRUM_JWT_NAMESPACES: 'ferrum, tenant-a',
    });
    const { loadConfig } = await loadModule();
    expect(loadConfig()).toMatchObject({
      jwtRole: 'operator',
      jwtAudience: ['admin-a', 'admin-b'],
      jwtNamespaces: ['ferrum', 'tenant-a'],
    });
  });

  it('rejects invalid URL forms and schemes', async () => {
    for (const url of ['file:///etc/passwd', 'http://user:pass@example.test', 'http://example.test/admin']) {
      clearTestEnv();
      setValidEnv({ FERRUM_ADMIN_URL: url });
      const { loadConfig } = await loadModule();
      expect(() => loadConfig()).toThrow(/FERRUM_ADMIN_URL/);
    }
  });

  it('rejects unsafe authentication redirects and malformed CIDR policy', async () => {
    setValidEnv({ FERRUM_AUTH_LOGIN_URL: 'javascript:alert(1)' });
    const redirect = await loadModule();
    expect(() => redirect.loadConfig()).toThrow(/FERRUM_AUTH_LOGIN_URL/);

    clearTestEnv();
    setValidEnv({ FERRUM_ADMIN_ALLOWED_CIDRS: '10.0.0.0/99' });
    const cidr = await loadModule();
    expect(() => cidr.loadConfig()).toThrow(/FERRUM_ADMIN_ALLOWED_CIDRS/);
  });

  it('rejects non-integer, non-finite, negative, and out-of-range numeric settings', async () => {
    for (const [name, value] of [
      ['FERRUM_JWT_TTL', 'NaN'],
      ['FERRUM_CONNECT_TIMEOUT', '-1'],
      ['FERRUM_READ_TIMEOUT', '1.5'],
      ['FERRUM_WRITE_TIMEOUT', 'Infinity'],
      ['PORT', '70000'],
    ]) {
      clearTestEnv();
      setValidEnv({ [name]: value });
      const { loadConfig } = await loadModule();
      expect(() => loadConfig()).toThrow(new RegExp(name));
    }
  });

  it('rejects a token TTL above the configured gateway maximum', async () => {
    setValidEnv({ FERRUM_JWT_TTL: '3601', FERRUM_JWT_MAX_TTL: '3600' });
    const { loadConfig } = await loadModule();
    expect(() => loadConfig()).toThrow(/must not exceed/);
  });

  it('fails closed on static authentication in production', async () => {
    setValidEnv({ NODE_ENV: 'production' });
    const { loadConfig } = await loadModule();
    expect(() => loadConfig()).toThrow(/Static authentication is disabled/);
  });

  it('allows an explicit development-only static production override', async () => {
    setValidEnv({ NODE_ENV: 'production', FERRUM_ALLOW_INSECURE_STATIC_AUTH: 'true' });
    const { loadConfig } = await loadModule();
    expect(loadConfig().authMode).toBe('static');
  });

  it('supports trusted-proxy production auth without a browser bearer token', async () => {
    setValidEnv({
      NODE_ENV: 'production',
      FERRUM_AUTH_MODE: 'trusted-proxy',
      FERRUM_BFF_AUTH_TOKEN: undefined,
      FERRUM_TRUSTED_PROXY_SECRET: 'p'.repeat(40),
    });
    const { loadConfig } = await loadModule();
    expect(loadConfig()).toMatchObject({ authMode: 'trusted-proxy', bffAuthToken: undefined });
  });

  it('keeps runtime connection mutation disabled by default', async () => {
    setValidEnv();
    const { updateRuntimeConfig } = await loadModule();
    await expect(updateRuntimeConfig({ adminUrl: 'https://gateway.example' })).rejects.toThrow(/disabled/);
  });

  it('allows only pre-authorized runtime gateway origins', async () => {
    setValidEnv({
      FERRUM_ALLOW_RUNTIME_SETTINGS: 'true',
      FERRUM_ADMIN_ALLOWED_ORIGINS: 'https://gateway.example',
    });
    const { loadConfig, updateRuntimeConfig } = await loadModule();
    await updateRuntimeConfig({ adminUrl: 'https://gateway.example' });
    expect(loadConfig().adminUrl).toBe('https://gateway.example');
    await expect(updateRuntimeConfig({ adminUrl: 'http://169.254.169.254' })).rejects.toThrow(/allow/i);
  });

  it('validates a runtime update atomically before changing any field', async () => {
    setValidEnv({
      FERRUM_ALLOW_RUNTIME_SETTINGS: 'true',
      FERRUM_ADMIN_ALLOWED_ORIGINS: 'https://gateway.example',
    });
    const { loadConfig, updateRuntimeConfig } = await loadModule();
    await expect(updateRuntimeConfig({
      adminUrl: 'https://gateway.example',
      readTimeout: -1,
    })).rejects.toThrow(/readTimeout/);
    expect(loadConfig().adminUrl).toBe('http://127.0.0.1:9000');
  });

  it('returns defensive copies of namespace and network policy arrays', async () => {
    setValidEnv({
      FERRUM_JWT_NAMESPACES: 'tenant-a',
      FERRUM_ADMIN_ALLOWED_CIDRS: '10.0.0.0/8',
    });
    const { loadConfig } = await loadModule();
    const first = loadConfig();
    first.jwtNamespaces?.push('attacker');
    first.adminAllowedCidrs.push('0.0.0.0/0');
    expect(loadConfig().jwtNamespaces).toEqual(['tenant-a']);
    expect(loadConfig().adminAllowedCidrs).toEqual(['10.0.0.0/8']);
  });

  it('never exposes the signing secret or local CA path in public settings', async () => {
    setValidEnv();
    const { getPublicRuntimeConfig } = await loadModule();
    const serialized = JSON.stringify(getPublicRuntimeConfig());
    expect(serialized).not.toContain('j'.repeat(40));
    expect(getPublicRuntimeConfig()).not.toHaveProperty('jwtSecret');
    expect(getPublicRuntimeConfig()).not.toHaveProperty('tlsCaPath');
  });
});
