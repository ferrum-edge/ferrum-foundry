import { expect, it, vi } from 'vitest';
import { signAdminJwt } from '../../shared/admin-jwt.js';

const DIAGNOSTIC_REF_PATTERN = /^fd[12]_[0-9a-f_]+$/;

// Executed by Pinned Gateway Contract only, against its disposable gateway
// started with FERRUM_DIAGNOSTIC_REFS=errors. Quality Gate exercises the route
// with a mocked upstream (diagnostics.test.ts).
it.runIf(process.env.FERRUM_DIAGNOSTICS_GATEWAY_CONTRACT === 'true')(
  'resolves a real gateway diagnostic reference only for a listed role',
  async () => {
    const namespace = process.env.FERRUM_NAMESPACE ?? 'ferrum-foundry-demo';
    const adminUrl = process.env.FERRUM_ADMIN_URL!;
    const dataPlaneUrl = process.env.FERRUM_DATA_PLANE_URL ?? 'http://127.0.0.1:8000';
    const proxyId = `diagnostics-contract-${Date.now().toString(36)}`;
    const token = await signAdminJwt({
      secret: process.env.FERRUM_JWT_SECRET!,
      issuer: process.env.FERRUM_JWT_ISSUER ?? 'ferrum-edge',
      subject: 'foundry-diagnostics-contract', role: 'admin', namespaces: [namespace],
      audience: process.env.FERRUM_JWT_AUDIENCE, ttlSeconds: 300,
    });
    async function admin(path: string, method = 'GET', body?: unknown) {
      return fetch(new URL(path, adminUrl), {
        method, signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'x-ferrum-namespace': namespace,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    const proof = 'hosted-diagnostics-proof-long-enough-x';
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
    vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
    vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
    vi.stubEnv('FERRUM_DIAGNOSTICS_ROLES', 'operator');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp({ serveStatic: false, logger: false });
    async function session(role: string) {
      const identity = {
        'x-ferrum-auth-secret': proof, 'x-forwarded-user': `diagnostics-${role}`,
        'x-ferrum-role': role, 'x-ferrum-namespaces': namespace,
      };
      const opened = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity });
      expect(opened.statusCode).toBe(200);
      return {
        ...identity,
        cookie: opened.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
        'x-ferrum-namespace': namespace,
      };
    }

    try {
      // A route whose backend refuses connections, so the gateway itself
      // answers with an error and stamps a diagnostic reference.
      const created = await admin('/proxies?apply=sync', 'POST', {
        id: proxyId, name: proxyId, listen_path: `/${proxyId}`, hosts: [],
        backend_scheme: 'http', backend_host: '127.0.0.1', backend_port: 1,
        strip_listen_path: true,
      });
      expect([200, 201], await created.clone().text()).toContain(created.status);

      let ref: string | null = null;
      for (let attempt = 0; attempt < 20 && !ref; attempt += 1) {
        const response = await fetch(`${dataPlaneUrl}/${proxyId}`, { signal: AbortSignal.timeout(10_000) });
        await response.arrayBuffer();
        if (response.status >= 500) ref = response.headers.get('x-ferrum-diagnostic-ref');
        if (!ref) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(ref, 'the gateway stamped a diagnostic reference').toMatch(DIAGNOSTIC_REF_PATTERN);

      // An unlisted role is refused by the BFF before the gateway is asked.
      const admins = await session('admin');
      const refused = await app.inject({ method: 'GET', url: `/api/diagnostics/refs/${ref}`, headers: admins });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED');

      // The listed role resolves it through the gateway's own lookup.
      const operators = await session('operator');
      const resolved = await app.inject({ method: 'GET', url: `/api/diagnostics/refs/${ref}`, headers: operators });
      expect(resolved.statusCode, resolved.body).toBe(200);
      const lookup = resolved.json();
      expect(lookup).toMatchObject({
        schema_version: 'ferrum.diagnostic_ref.v1', ref, namespace, detail_available: true,
      });
      expect(lookup.status).toBeGreaterThanOrEqual(500);
      expect(lookup.detail.proxy_id).toBe(proxyId);

      // A reference the gateway does not hold is a miss, not an error.
      const unknown = `fd1_${'0'.repeat(32)}`;
      const missed = await app.inject({ method: 'GET', url: `/api/diagnostics/refs/${unknown}`, headers: operators });
      expect(missed.statusCode).toBe(404);
      expect(missed.json().code).toBe('FERRUM_BFF_DIAGNOSTIC_NOT_FOUND');

      // Ordinary proxy tokens never carry the scope, so Edge refuses them.
      const proxied = await app.inject({
        method: 'GET', url: `/api/proxy/diagnostics/v1/refs/${ref}`,
        headers: { ...operators, 'x-csrf-token': 'unused-on-get' },
      });
      expect(proxied.statusCode).toBe(403);
    } finally {
      await admin(`/proxies/${proxyId}?apply=sync&cleanup_orphaned_upstream=false`, 'DELETE');
      await app.close();
    }
  },
  60_000,
);
