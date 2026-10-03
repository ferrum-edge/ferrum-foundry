import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { fetch } from 'undici';
import { closeDispatchers, getDispatcher, getProbeDispatcher } from './tls.js';

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
    gatewayMaxConnections: 128,
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
  it('reuses the transport when only response deadlines change', () => {
    const first = getDispatcher(makeConfig({ readTimeout: 610_000 }));
    expect(getDispatcher(makeConfig({ readTimeout: 30_000 }))).toBe(first);
    expect(first.closed).toBe(false);
  });

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
    writeFileSync(caPath, rootCertificates[0]!);
    const config = makeConfig({
      adminUrl: 'https://gateway.example',
      initialAdminOrigin: 'https://gateway.example',
      tlsCaPath: caPath,
      tlsCaRoot: root,
    });

    const first = getDispatcher(config);
    writeFileSync(caPath, rootCertificates[1]!);
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
    writeFileSync(join(firstData, 'ca.pem'), rootCertificates[0]!);
    writeFileSync(join(secondData, 'ca.pem'), rootCertificates[1]!);
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

  it.each([
    '[64:ff9b::a9fe:a9fe]', // NAT64 of 169.254.169.254
    '[64:ff9b::10.0.0.1]', // NAT64 with a dotted tail
    '[64:ff9b:1::a00:1]',
    '[2002:a9fe:a9fe::1]', // 6to4 of 169.254.169.254
    '[::7f00:1]', // IPv4-compatible 127.0.0.1
    '[::ffff:7f00:1]', // IPv4-mapped 127.0.0.1
    '[fec0::1]',
    '[100::1]',
  ])('rejects a runtime-selected IPv6 spelling of a blocked range: %s', (host) => {
    const config = makeConfig({
      adminUrl: `http://${host}`,
      initialAdminOrigin: 'https://gateway.example',
      adminAllowedOrigins: [`http://${host}`],
    });
    expect(() => getDispatcher(config)).toThrow(/network policy/);
  });

  it.each([
    '[64:ff9b::808:808]', // DNS64-synthesized 8.8.8.8
    '[2002:808:808::1]', // 6to4 of 8.8.8.8
  ])('permits a translated public IPv4 destination: %s', (host) => {
    const config = makeConfig({
      adminUrl: `http://${host}`,
      initialAdminOrigin: 'https://gateway.example',
      adminAllowedOrigins: [`http://${host}`],
    });
    expect(() => getDispatcher(config)).not.toThrow();
  });

  it('applies an IPv4 CIDR authorization to its NAT64 spelling', () => {
    const config = makeConfig({
      adminUrl: 'http://[64:ff9b::a14:1e28]',
      initialAdminOrigin: 'https://gateway.example',
      adminAllowedOrigins: ['http://[64:ff9b::a14:1e28]'],
      adminAllowedCidrs: ['10.20.30.40/32'],
    });
    expect(() => getDispatcher(config)).not.toThrow();
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

describe('gateway connection ceiling', () => {
  it('replaces the dispatcher when its connection ceiling changes', () => {
    const first = getDispatcher(makeConfig());
    expect(getDispatcher(makeConfig({ gatewayMaxConnections: 256 }))).not.toBe(first);
    expect(first.closed).toBe(true);
  });

  it('opens at most the configured sockets, queues the rest, and keeps readiness on its own', async () => {
    const waiting: ServerResponse[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => { waiting.push(response); });
    server.on('connection', (socket) => sockets.add(socket));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = makeConfig({ adminUrl: origin, initialAdminOrigin: origin, gatewayMaxConnections: 2 });
    const controller = new AbortController();
    const request = (path: string, dispatcher = getDispatcher(config)) => fetch(`${origin}${path}`, {
      dispatcher,
      signal: controller.signal,
    }).then((response) => response.text()).catch(() => undefined);
    try {
      const pending = [request('/held'), request('/held'), request('/queued')];
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The third request waits for a connection instead of opening one.
      expect(waiting).toHaveLength(2);
      expect(sockets.size).toBe(2);

      // Readiness does not queue behind a saturated proxy pool.
      const probe = getProbeDispatcher(config);
      expect(probe).not.toBe(getDispatcher(config));
      const ready = request('/health', probe);
      await vi.waitFor(() => expect(waiting).toHaveLength(3));
      expect(sockets.size).toBe(3);

      // A freed proxy connection serves the queued request.
      waiting[0]!.end('done');
      await vi.waitFor(() => expect(waiting).toHaveLength(4));
      expect(sockets.size).toBe(3);
      for (const response of waiting.slice(1)) response.end('done');
      expect(await Promise.all([...pending, ready])).toEqual(['done', 'done', 'done', 'done']);
    } finally {
      controller.abort();
      for (const response of waiting) response.destroy();
      server.closeAllConnections();
      server.close();
    }
  });
});
