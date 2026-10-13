import cookie from '@fastify/cookie';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #592: unauthenticated health callers get only the verdict; the version
// and the gateway's own state need a session. These cases cover every gateway
// outcome, both authentication modes, and the readiness cache the two share.

const PROXY_SECRET = 'health-route-proxy-test-secret-long-enough';
const BFF_TOKEN = 'health-route-static-test-token-long-enough';

type GatewayMode = 'ok' | 'degraded' | 'down' | 'reject';
let gatewayMode: GatewayMode = 'ok';

const gateway = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') {
    if (gatewayMode === 'down') {
      response.statusCode = 503;
      response.end('{"status":"unavailable","ready":false}');
      return;
    }
    response.end(JSON.stringify({ status: gatewayMode === 'degraded' ? 'degraded' : 'ok', ready: true }));
    return;
  }
  if (request.url?.startsWith('/namespaces')) {
    if (gatewayMode === 'reject') {
      response.statusCode = 401;
      response.end('{"error":"invalid token"}');
      return;
    }
    response.end('{"data":[]}');
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});

let app: FastifyInstance | undefined;

beforeAll(async () => {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
});

afterAll(async () => {
  // The probe dispatcher keeps its connections alive; end them so close() returns.
  gateway.closeAllConnections();
  gateway.close();
  await once(gateway, 'close');
});

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`);
  vi.stubEnv('FERRUM_JWT_SECRET', 'health-route-signing-test-secret-long-enough');
  vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function setup(mode: 'static' | 'trusted-proxy', gatewayState: GatewayMode) {
  gatewayMode = gatewayState;
  vi.stubEnv('FERRUM_AUTH_MODE', mode);
  if (mode === 'static') {
    vi.stubEnv('FERRUM_JWT_NAMESPACES', '*');
    vi.stubEnv('FERRUM_BFF_AUTH_TOKEN', BFF_TOKEN);
  } else {
    vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', PROXY_SECRET);
  }
  const { authPlugin } = await import('../auth.js');
  const { default: healthPlugin } = await import('./health.js');
  app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(healthPlugin);
  let authenticated: Record<string, string>;
  if (mode === 'static') {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: BFF_TOKEN } });
    expect(login.statusCode).toBe(200);
    authenticated = { cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ') };
  } else {
    authenticated = {
      'x-ferrum-auth-secret': PROXY_SECRET,
      'x-forwarded-user': 'health-admin@example.test',
      'x-ferrum-role': 'admin',
    };
  }
  return { app, authenticated };
}

const ANONYMOUS_KEYS = ['ready', 'status'];

describe('health disclosure (#592)', () => {
  for (const mode of ['static', 'trusted-proxy'] as const) {
    describe(`${mode} authentication`, () => {
      it('hides a degraded gateway from an anonymous probe and shows it to a session', async () => {
        const { app, authenticated } = await setup(mode, 'degraded');
        const anonymous = await app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(anonymous.statusCode).toBe(200);
        expect(anonymous.json()).toEqual({ status: 'ready', ready: true });

        // The same cached probe result, rendered for a session.
        const detailed = await app.inject({ method: 'GET', url: '/api/health/ready', headers: authenticated });
        expect(detailed.statusCode).toBe(200);
        expect(detailed.json()).toMatchObject({
          status: 'degraded',
          ready: true,
          version: expect.any(String),
          checkedAt: expect.any(String),
          components: { bff: { status: 'ok' }, gateway: { status: 'degraded', httpStatus: 200 } },
        });

        // And anonymous again after the session's render: nothing leaks back.
        const again = await app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(Object.keys(again.json()).sort()).toEqual(ANONYMOUS_KEYS);
      });

      it('reports an unhealthy gateway only as unavailable without a session', async () => {
        const { app, authenticated } = await setup(mode, 'down');
        const anonymous = await app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(anonymous.statusCode).toBe(503);
        expect(anonymous.json()).toEqual({ status: 'unavailable', ready: false });
        const detailed = await app.inject({ method: 'GET', url: '/api/health/ready', headers: authenticated });
        expect(detailed.statusCode).toBe(503);
        expect(detailed.json()).toMatchObject({
          status: 'unavailable',
          version: expect.any(String),
          components: { gateway: { status: 'unavailable', httpStatus: 503 } },
        });
      });

      it('does not disclose the Admin API status of a rejected probe', async () => {
        const { app, authenticated } = await setup(mode, 'reject');
        const anonymous = await app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(anonymous.statusCode).toBe(503);
        expect(anonymous.json()).toEqual({ status: 'unavailable', ready: false });
        const detailed = await app.inject({ method: 'GET', url: '/api/health/ready', headers: authenticated });
        expect(detailed.json()).toMatchObject({ components: { gateway: { httpStatus: 401 } } });
      });

      it('gives liveness its version only with a session', async () => {
        const { app, authenticated } = await setup(mode, 'ok');
        for (const url of ['/api/health', '/api/health/live']) {
          expect((await app.inject({ method: 'GET', url })).json()).toEqual({ status: 'ok' });
          expect((await app.inject({ method: 'GET', url, headers: authenticated })).json())
            .toEqual({ status: 'ok', version: expect.any(String) });
        }
      });
    });
  }

  it('treats a trusted-proxy assertion with the wrong proof as anonymous', async () => {
    const { app, authenticated } = await setup('trusted-proxy', 'degraded');
    const forged = { ...authenticated, 'x-ferrum-auth-secret': 'not-the-proxy-secret-but-long-enough' };
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready', headers: forged });
    expect(ready.json()).toEqual({ status: 'ready', ready: true });
    const live = await app.inject({ method: 'GET', url: '/api/health/live', headers: forged });
    expect(live.json()).toEqual({ status: 'ok' });
  });
});
