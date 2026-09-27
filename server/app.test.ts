import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BuildAppOptions } from './app.js';

const ENV = {
  NODE_ENV: 'production',
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'test-signing-secret-is-long-enough-123',
  FERRUM_AUTH_MODE: 'trusted-proxy',
  FERRUM_TRUSTED_PROXY_SECRET: 'trusted-proxy-shared-secret-is-long-enough',
  FERRUM_JWT_NAMESPACES: undefined,
};
const snapshot: Record<string, string | undefined> = {};

async function loadApp(
  overrides: Record<string, string | undefined> = {},
  logger: BuildAppOptions['logger'] = false,
) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp({ serveStatic: false, logger });
  app.get('/ip', async (request) => ({ ip: request.ip }));
  return app;
}

beforeAll(() => {
  for (const key of Object.keys(ENV)) snapshot[key] = process.env[key];
});

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('request receive deadline', () => {
  it('applies a server-level absolute receive timeout as an upload backstop', async () => {
    const previous = process.env.FERRUM_UPLOAD_TIMEOUT;
    delete process.env.FERRUM_UPLOAD_TIMEOUT;
    const app = await loadApp();
    try {
      // Node's own absolute receive deadline, kept deliberately looser than the
      // proxy's upload deadline so it only catches a request that never reaches
      // the guarded upload stream.
      expect(app.server.requestTimeout).toBe(305_000);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.FERRUM_UPLOAD_TIMEOUT;
      else process.env.FERRUM_UPLOAD_TIMEOUT = previous;
    }
  });
});

describe('forwarded client address', () => {
  it('exports a predicate that trusts only the directly connected hop', async () => {
    const { trustDirectlyConnectedProxy } = await import('./app.js');
    expect(trustDirectlyConnectedProxy('10.0.0.5', 0)).toBe(true);
    expect(trustDirectlyConnectedProxy('203.0.113.9', 1)).toBe(false);
    expect(trustDirectlyConnectedProxy('203.0.113.9', 7)).toBe(false);
  });

  it('takes the client address the identity proxy appended, and nothing further out', async () => {
    const app = await loadApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
      });
      expect(response.statusCode).toBe(200);
      // 10.0.0.5 is the proxy itself; 203.0.113.9 could have been supplied by
      // anyone upstream of the proxy. 198.51.100.7 is what the proxy observed.
      expect(response.json()).toEqual({ ip: '198.51.100.7' });
    } finally {
      await app.close();
    }
  });

  it('ignores forwarded headers outside production', async () => {
    const app = await loadApp({
      NODE_ENV: 'test',
      FERRUM_AUTH_MODE: 'static',
      FERRUM_BFF_AUTH_TOKEN: 'development-bff-token-is-long-enough-123',
      FERRUM_JWT_NAMESPACES: '*',
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      expect(response.json()).toEqual({ ip: '10.0.0.5' });
    } finally {
      await app.close();
    }
  });
});

describe('static namespace scope at startup', () => {
  const STATIC_MODE = {
    NODE_ENV: 'test',
    FERRUM_AUTH_MODE: 'static',
    FERRUM_BFF_AUTH_TOKEN: 'development-bff-token-is-long-enough-123',
  };

  it('refuses to start when FERRUM_JWT_NAMESPACES is unset, naming both options', async () => {
    await expect(loadApp({ ...STATIC_MODE, FERRUM_JWT_NAMESPACES: undefined })).rejects.toThrow(
      /FERRUM_JWT_NAMESPACES is required in static authentication mode \(FERRUM_AUTH_MODE=static, the default\); set it to namespace names, or \* for every namespace/,
    );
  });

  it('refuses to start when FERRUM_JWT_NAMESPACES names no namespace', async () => {
    await expect(loadApp({ ...STATIC_MODE, FERRUM_JWT_NAMESPACES: ' , ' })).rejects.toThrow(
      /FERRUM_JWT_NAMESPACES must list at least one namespace, or \* for every namespace/,
    );
  });

  it.each(['*', 'tenant-a,tenant-b'])('starts with an explicit scope %j', async (value) => {
    const app = await loadApp({ ...STATIC_MODE, FERRUM_JWT_NAMESPACES: value });
    await app.close();
  });

  it('starts in trusted-proxy mode without FERRUM_JWT_NAMESPACES, where the identity proxy supplies grants', async () => {
    const app = await loadApp({
      FERRUM_AUTH_MODE: 'trusted-proxy',
      FERRUM_BFF_AUTH_TOKEN: undefined,
      FERRUM_JWT_NAMESPACES: undefined,
    });
    await app.close();
  });
});
