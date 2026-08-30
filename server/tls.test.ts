import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { closeDispatchers, getDispatcher } from './tls.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    adminUrl: 'http://127.0.0.1:9000',
    initialAdminOrigin: 'http://127.0.0.1:9000',
    adminAllowedOrigins: [],
    adminAllowedCidrs: [],
    jwtSecret: 'test-signing-secret-is-long-enough-123',
    jwtIssuer: 'ferrum-edge',
    jwtTtl: 900,
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
    authMode: 'static',
    bffAuthToken: 'test-bff-token-is-long-enough-123456',
    sessionTtl: 3600,
    trustedProxySecret: undefined,
    trustedProxyUserHeader: 'x-forwarded-user',
    trustedProxyRoleHeader: 'x-ferrum-role',
    trustedProxyNamespacesHeader: 'x-ferrum-namespaces',
    authLoginUrl: undefined,
    authLogoutUrl: undefined,
    secureCookies: false,
    enableHsts: false,
    ...overrides,
  };
}

afterEach(() => closeDispatchers());

describe('managed Undici dispatchers', () => {
  it('reuses one dispatcher for an unchanged effective connection configuration', () => {
    const config = makeConfig();
    expect(getDispatcher(config)).toBe(getDispatcher({ ...config }));
  });

  it('atomically replaces the dispatcher when connection settings change', async () => {
    const first = getDispatcher(makeConfig());
    const second = getDispatcher(makeConfig({ connectTimeout: 6000 }));
    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
    await closeDispatchers();
    expect(second.closed).toBe(true);
  });

  it('rejects a runtime-selected metadata/private address outside explicit policy', () => {
    const config = makeConfig({
      adminUrl: 'http://169.254.169.254',
      initialAdminOrigin: 'https://gateway.example',
      adminAllowedOrigins: ['http://169.254.169.254'],
    });
    expect(() => getDispatcher(config)).toThrow(/network policy/);
  });

  it('permits an operator-authorized private CIDR', () => {
    const config = makeConfig({
      adminUrl: 'http://10.20.30.40',
      initialAdminOrigin: 'https://gateway.example',
      adminAllowedOrigins: ['http://10.20.30.40'],
      adminAllowedCidrs: ['10.20.30.40/32'],
    });
    expect(() => getDispatcher(config)).not.toThrow();
  });
});
