import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { signAdminJwt } from '../../shared/admin-jwt.js';
import type { ServiceManifestPreview } from '../service-manifest.js';

// Executed by Pinned Gateway Contract only, after its disposable gateway is
// ready. Ordinary quality tests exercise the route with forbidden upstream I/O.
it.runIf(process.env.FERRUM_MANIFEST_GATEWAY_CONTRACT === 'true')(
  'qualifies explicit HTTP desired resources separately from side-effect-free preview',
  async () => {
    const namespace = 'foundry-manifest-contract';
    const adminUrl = process.env.FERRUM_ADMIN_URL!;
    const token = await signAdminJwt({
      secret: process.env.FERRUM_JWT_SECRET!,
      issuer: process.env.FERRUM_JWT_ISSUER ?? 'ferrum-edge',
      subject: 'foundry-manifest-contract', role: 'admin', namespaces: [namespace],
      audience: process.env.FERRUM_JWT_AUDIENCE, ttlSeconds: 300,
    });
    async function exchange(path: string, method = 'GET', body?: unknown, statuses = [200]) {
      const response = await fetch(new URL(path, adminUrl), {
        method, signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'x-ferrum-namespace': namespace,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      expect(statuses, `${method} ${path}: ${text.slice(0, 1000)}`).toContain(response.status);
      return text ? JSON.parse(text) : undefined;
    }

    const proof = 'hosted-manifest-preview-proof-long-enough';
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
    vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
    vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp({ serveStatic: false, logger: false });
    const identity = {
      'x-ferrum-auth-secret': proof, 'x-forwarded-user': 'hosted-manifest-reviewer',
      'x-ferrum-role': 'viewer', 'x-ferrum-namespaces': namespace,
    };
    const session = await app.inject({
      method: 'GET', url: '/api/auth/session', headers: identity,
    });
    expect(session.statusCode).toBe(200);
    const headers = {
      ...identity,
      cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-csrf-token': session.json().csrfToken as string,
      'x-ferrum-namespace': namespace, 'content-type': 'application/json',
    };
    const created: ServiceManifestPreview[] = [];
    try {
      await exchange('/namespaces', 'POST', { name: namespace }, [201]);
      const collections = ['proxies', 'upstreams', 'plugins/config'];
      const before = await Promise.all(collections.map((path) => exchange(`/${path}?limit=100`)));
      for (const health of [false, true]) {
        const input = JSON.parse(readFileSync(new URL(
          '../../contracts/ferrum-contracts/fixtures/service-manifest/valid/plain-http.json',
          import.meta.url,
        ), 'utf8'));
        const id = `manifest-contract-${health ? 'health' : 'direct'}`;
        input.service.name = id;
        input.api.public_path = `/${id}`;
        input.upstream.host = 'host.docker.internal';
        input.upstream.port = 9101;
        input.gateway.namespace = namespace;
        input.gateway.proxy_id = id;
        if (health) input.health = { path: '/health' };
        const response = await app.inject({
          method: 'POST', url: '/api/service-manifest/preview', headers,
          payload: JSON.stringify(input),
        });
        expect(response.statusCode).toBe(200);
        created.push(response.json<ServiceManifestPreview>());
      }
      const after = await Promise.all(collections.map((path) => exchange(`/${path}?limit=100`)));
      expect(after).toEqual(before);

      // The test explicitly applies the returned HTTP graph to the disposable
      // CI gateway. No production/UI path can perform this operation.
      for (const { desired } of created) {
        await exchange('/batch?apply=sync', 'POST', {
          proxies: [desired.proxy], upstreams: desired.upstream ? [desired.upstream] : [],
          consumers: [], plugin_configs: desired.plugin_configs,
        }, [201]);
        const proxy = await exchange(`/proxies/${desired.proxy.id}`);
        for (const key of [
          'listen_path', 'backend_scheme', 'backend_path', 'strip_listen_path',
          'backend_connect_timeout_ms', 'backend_read_timeout_ms', 'backend_write_timeout_ms',
        ]) expect(proxy[key]).toEqual(desired.proxy[key]);
        for (const reference of desired.proxy.plugins as object[]) {
          expect(proxy.plugins).toEqual(expect.arrayContaining([
            expect.objectContaining(reference),
          ]));
        }
        if (desired.upstream) {
          const upstream = await exchange(`/upstreams/${desired.upstream.id}`);
          expect(upstream.health_checks).toMatchObject(desired.upstream.health_checks as object);
          expect(upstream.algorithm).toBe('round_robin');
          expect(upstream.targets).toEqual(expect.arrayContaining([
            expect.objectContaining({ host: 'host.docker.internal', port: 9101, weight: 1 }),
          ]));
          expect(proxy.upstream_id).toBe(desired.upstream.id);
        } else {
          expect(proxy.backend_host).toBe('host.docker.internal');
          expect(proxy.backend_port).toBe(9101);
        }
        for (const plugin of desired.plugin_configs) {
          const persisted = await exchange(`/plugins/config/${plugin.id}`);
          expect(persisted.config).toMatchObject(plugin.config as object);
          expect(persisted.plugin_name).toBe(plugin.plugin_name);
        }
      }
    } finally {
      try {
        for (const { desired } of created) {
          await exchange(`/proxies/${desired.proxy.id}?apply=sync&cleanup_orphaned_upstream=false`,
            'DELETE', undefined, [200, 204, 404]);
          for (const plugin of desired.plugin_configs) {
            await exchange(`/plugins/config/${plugin.id}?apply=sync`,
              'DELETE', undefined, [200, 204, 404]);
          }
          if (desired.upstream) {
            await exchange(`/upstreams/${desired.upstream.id}?apply=sync`,
              'DELETE', undefined, [200, 204, 404]);
          }
        }
        await exchange(`/namespaces/${namespace}`, 'DELETE', undefined, [200, 204]);
      } finally {
        await app.close();
        vi.unstubAllEnvs();
      }
    }
  },
  120_000,
);
