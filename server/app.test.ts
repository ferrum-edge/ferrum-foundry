import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CSP_NONCE_PLACEHOLDER } from '../shared/csp-nonce.js';
import type { BuildAppOptions } from './app.js';

const ENV = {
  NODE_ENV: 'production',
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'test-signing-secret-is-long-enough-123',
  FERRUM_AUTH_MODE: 'trusted-proxy',
  FERRUM_TRUSTED_PROXY_SECRET: 'trusted-proxy-shared-secret-is-long-enough',
  FERRUM_JWT_NAMESPACES: undefined,
  FERRUM_SECURE_COOKIES: undefined,
  FERRUM_ENABLE_HSTS: undefined,
};
const snapshot: Record<string, string | undefined> = {};

async function loadApp(
  overrides: Record<string, string | undefined> = {},
  logger: BuildAppOptions['logger'] = false,
  appOptions: BuildAppOptions = { serveStatic: false },
) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp({ ...appOptions, logger });
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

describe('Strict-Transport-Security (#589)', () => {
  it('is sent by default in production and suppressed by an explicit opt-out', async () => {
    const defaults = await loadApp();
    try {
      const response = await defaults.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    } finally {
      await defaults.close();
    }

    const optedOut = await loadApp({ FERRUM_ENABLE_HSTS: 'false' });
    try {
      const response = await optedOut.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await optedOut.close();
    }

    const plainHttp = await loadApp({ FERRUM_SECURE_COOKIES: 'false' });
    try {
      const response = await plainHttp.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await plainHttp.close();
    }
  });
});

describe('SPA shell nonce (#594)', () => {
  const P = CSP_NONCE_PLACEHOLDER;
  // The shape Vite's html.cspNonce emits: every tag and a csp-nonce meta.
  const SHELL = `<!doctype html><html><head><meta property="csp-nonce" nonce="${P}">
<script nonce="${P}" src="/theme-bootstrap.js"></script>
<script type="module" crossorigin nonce="${P}" src="/assets/index-AbCdEf12.js"></script>
<link rel="stylesheet" crossorigin nonce="${P}" href="/assets/index-AbCdEf12.css">
</head><body><div id="root"></div></body></html>`;
  let dist: string;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'foundry-dist-'));
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), SHELL);
    await writeFile(join(dist, 'theme-bootstrap.js'), '/* theme */');
    await writeFile(join(dist, 'assets', 'index-AbCdEf12.js'), 'export {};');
  });

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  function styleSrc(header: string | string[] | number | undefined): string {
    return String(header)
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('style-src '))!;
  }

  it('templates a fresh nonce into the shell and names it in style-src, without unsafe-inline', async () => {
    const app = await loadApp({}, false, { serveStatic: true, distPath: dist });
    try {
      const nonces = new Set<string>();
      for (const url of ['/', '/index.html', '/proxies/some-id', '/settings?tab=x']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');

        const policy = styleSrc(response.headers['content-security-policy']);
        expect(policy).not.toContain('unsafe-inline');
        const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
        expect(nonce, url).toMatch(/^[0-9a-f]{32}$/);

        expect(response.body).not.toContain(P);
        expect(response.body).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
        expect(response.body.split(`nonce="${nonce}"`)).toHaveLength(5);
        nonces.add(nonce!);
      }
      expect(nonces.size, 'every response gets its own nonce').toBe(4);
    } finally {
      await app.close();
    }
  });

  it('still serves built files directly and refuses missing chunks and writes', async () => {
    const app = await loadApp({}, false, { serveStatic: true, distPath: dist });
    try {
      const chunk = await app.inject({ method: 'GET', url: '/assets/index-AbCdEf12.js' });
      expect(chunk.statusCode).toBe(200);
      expect(chunk.headers['cache-control']).toBe('public, max-age=31536000, immutable');

      const theme = await app.inject({ method: 'GET', url: '/theme-bootstrap.js' });
      expect(theme.statusCode).toBe(200);
      expect(theme.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');

      const missing = await app.inject({ method: 'GET', url: '/assets/index-Gone1234.js' });
      expect(missing.statusCode).toBe(404);

      const write = await app.inject({ method: 'POST', url: '/proxies' });
      expect(write.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses to start on a shell built without the nonce placeholder', async () => {
    const stale = await mkdtemp(join(tmpdir(), 'foundry-dist-stale-'));
    try {
      await writeFile(join(stale, 'index.html'), '<!doctype html><html><head></head></html>');
      await expect(loadApp({}, false, { serveStatic: true, distPath: stale })).rejects.toThrow(
        /no CSP nonce placeholder/,
      );
    } finally {
      await rm(stale, { recursive: true, force: true });
    }
  });
});
