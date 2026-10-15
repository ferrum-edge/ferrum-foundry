import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FAIL, PASS, checkTrustBoundary } from '../scripts/starter-preflight.mjs';

// The starter preflight's header-stripping probe against the real BFF
// authentication chain (#603). A denial proves stripping only if the BFF
// would have served the forged identity had it arrived intact, so a
// passthrough front door must fail the check rather than be refused for an
// unrelated prerequisite such as the selected namespace.

const PROXY_SECRET = 'preflight-boundary-proxy-secret-is-long-enough';
const NAMESPACE = 'production';
const ENV = {
  NODE_ENV: 'production',
  FERRUM_ADMIN_URL: 'http://127.0.0.1:9999',
  FERRUM_JWT_SECRET: 'preflight-boundary-signing-secret-is-long-enough',
  FERRUM_AUTH_MODE: 'trusted-proxy',
  FERRUM_TRUSTED_PROXY_SECRET: PROXY_SECRET,
  FERRUM_SECURE_COOKIES: 'false',
};
const PREFLIGHT_ENV = {
  FOUNDRY_PREFLIGHT_URL: 'https://foundry.example.test',
  FERRUM_TRUSTED_PROXY_SECRET: PROXY_SECRET,
  FERRUM_NAMESPACE: NAMESPACE,
};
const IDENTITY_HEADERS = new Set([
  'x-ferrum-auth-secret',
  'x-forwarded-user',
  'x-ferrum-role',
  'x-ferrum-namespaces',
]);
const snapshot: Record<string, string | undefined> = {};

let app: FastifyInstance;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  delete process.env.FERRUM_BFF_AUTH_TOKEN;
  vi.resetModules();
  const auth = await import('./auth.js');
  app = Fastify();
  await app.register(cookie);
  await app.register(auth.authPlugin);
  // The proxy route's authentication and namespace ceiling, answering as the
  // gateway would for a request the BFF lets through.
  app.all(
    '/api/proxy/*',
    { onRequest: [auth.requireAdminAuth, auth.requireNamespaceCeiling] },
    async () => ({ data: [] }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const key of Object.keys(ENV)) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type HeaderMap = Record<string, string>;

/**
 * A front door in front of the BFF, as `fetch` sees it: `forward` decides
 * which client headers reach the BFF. No listener is opened.
 */
function frontDoor(forward: (headers: HeaderMap) => HeaderMap) {
  return async (input: URL | string, init: { headers?: HeaderMap } = {}): Promise<Response> => {
    const target = new URL(String(input));
    const response = await app.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: forward({ ...init.headers }),
    });
    return new Response(response.body, { status: response.statusCode });
  };
}

/** Forwards every client header, as a BFF reached directly would see them. */
const passthrough = frontDoor((headers) => headers);

/**
 * Replaces the client's identity headers, as the starter's `proxy_set_header`
 * lines do; with no signed-in user there is no identity to assert instead.
 */
const stripping = frontDoor((headers) => Object.fromEntries(
  Object.entries(headers).filter(([name]) => !IDENTITY_HEADERS.has(name.toLowerCase())),
));

describe('starter preflight header-stripping probe against the BFF (#603)', () => {
  it('fails when the front door forwards client identity headers to the BFF', async () => {
    const results = await checkTrustBoundary(PREFLIGHT_ENV, passthrough);

    expect(results.map((result: { status: string }) => result.status)).toEqual([PASS, FAIL]);
    expect(results[1].detail).toMatch(/forged X-Ferrum-Role: admin request was served/);
  });

  it('passes when the front door strips client identity headers', async () => {
    const results = await checkTrustBoundary(PREFLIGHT_ENV, stripping);

    expect(results.map((result: { status: string }) => result.status)).toEqual([PASS, PASS]);
    expect(results[1].detail).toBe('answered 401');
  });

  it('a forged identity without the selected namespace is refused by the ceiling, not by stripping', async () => {
    // The probe shape before #603: accepted identity, missing namespace
    // selection. This 403 is why the probe must select its namespace.
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy/proxies?offset=0&limit=1',
      headers: {
        'x-ferrum-auth-secret': PROXY_SECRET,
        'x-forwarded-user': 'preflight-forged',
        'x-ferrum-role': 'admin',
        'x-ferrum-namespaces': NAMESPACE,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Namespace access denied' });
  });
});
