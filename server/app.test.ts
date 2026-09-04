import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ENV = {
  NODE_ENV: 'production',
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'test-signing-secret-is-long-enough-123',
  FERRUM_AUTH_MODE: 'trusted-proxy',
  FERRUM_TRUSTED_PROXY_SECRET: 'trusted-proxy-shared-secret-is-long-enough',
};
const snapshot: Record<string, string | undefined> = {};

async function loadApp(overrides: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp({ serveStatic: false, logger: false });
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
    const app = await loadApp({ NODE_ENV: 'test', FERRUM_AUTH_MODE: 'static', FERRUM_BFF_AUTH_TOKEN: 'development-bff-token-is-long-enough-123' });
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
