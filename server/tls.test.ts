import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { closeDispatchers, getDispatcher } from './tls.js';

const directories: string[] = [];

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'foundry-tls-test-'));
  directories.push(path);
  return path;
}

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

afterEach(async () => {
  vi.useRealTimers();
  await closeDispatchers();
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

  it('replaces the dispatcher after the bounded CA recheck detects an in-place change', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const root = tempDirectory();
    const caPath = join(root, 'ca.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfirst\n-----END CERTIFICATE-----\n');
    const config = makeConfig({
      adminUrl: 'https://gateway.example',
      initialAdminOrigin: 'https://gateway.example',
      tlsCaPath: caPath,
      tlsCaRoot: root,
    });

    const first = getDispatcher(config);
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nrotated-material\n-----END CERTIFICATE-----\n');
    expect(getDispatcher(config)).toBe(first);
    vi.advanceTimersByTime(1_001);
    const second = getDispatcher(config);

    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
  });

  it('replaces the dispatcher when a projected CA volume atomically rotates its target', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const root = tempDirectory();
    const firstData = join(root, '..data-1');
    const secondData = join(root, '..data-2');
    mkdirSync(firstData);
    mkdirSync(secondData);
    writeFileSync(join(firstData, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfirst\n-----END CERTIFICATE-----\n');
    writeFileSync(join(secondData, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nsecond\n-----END CERTIFICATE-----\n');
    symlinkSync('..data-1', join(root, '..data'));
    symlinkSync('..data/ca.pem', join(root, 'ca.pem'));
    const config = makeConfig({
      adminUrl: 'https://gateway.example',
      initialAdminOrigin: 'https://gateway.example',
      tlsCaPath: join(root, 'ca.pem'),
      tlsCaRoot: root,
    });

    const first = getDispatcher(config);
    symlinkSync('..data-2', join(root, '..data-next'));
    renameSync(join(root, '..data-next'), join(root, '..data'));
    vi.advanceTimersByTime(1_001);
    const second = getDispatcher(config);

    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
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
