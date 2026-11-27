import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { signAdminJwt } from '../../shared/admin-jwt.js';
import { collectBoundedPages } from '../../src/api/pagination.js';
import type { PaginatedResponse } from '../../src/api/types.js';

/** Resources seeded per collection; the measured envelope in docs/compatibility.md. */
const RECORDS = Number(process.env.FERRUM_SCALE_RECORDS ?? 1000);
const LIST_PAGE = 50;
const TRAVERSAL_PAGE = 250;

interface Measurement {
  read: string;
  requests: number;
  bytes: number;
  ms: number;
}

// Executed by Pinned Gateway Contract only, against its disposable gateway.
// Seeds RECORDS proxies and RECORDS upstreams in one namespace, then reads
// them back through Foundry's BFF the way the UI does, and reports what it
// measured. Latency is reported, not asserted: hosted runners vary.
it.runIf(process.env.FERRUM_SCALE_GATEWAY_CONTRACT === 'true')(
  `serves ${RECORDS} proxies and ${RECORDS} upstreams through the BFF`,
  async () => {
    const namespace = `foundry-scale-${Date.now().toString(36)}`;
    const adminUrl = process.env.FERRUM_ADMIN_URL!;
    const token = await signAdminJwt({
      secret: process.env.FERRUM_JWT_SECRET!,
      issuer: process.env.FERRUM_JWT_ISSUER ?? 'ferrum-edge',
      subject: 'foundry-scale-contract', role: 'admin', namespaces: [namespace],
      audience: process.env.FERRUM_JWT_AUDIENCE, ttlSeconds: 900,
    });
    async function admin(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(new URL(path, adminUrl), {
        method, signal: AbortSignal.timeout(300_000),
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'x-ferrum-namespace': namespace,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    }

    const proof = 'hosted-scale-contract-proof-long-enough';
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
    vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
    vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp({ serveStatic: false, logger: false });
    const identity = {
      'x-ferrum-auth-secret': proof, 'x-forwarded-user': 'scale-reviewer',
      'x-ferrum-role': 'viewer', 'x-ferrum-namespaces': namespace,
    };
    const opened = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity });
    expect(opened.statusCode).toBe(200);
    const headers = {
      ...identity,
      cookie: opened.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-ferrum-namespace': namespace,
    };

    const measurements: Measurement[] = [];
    type Row = { id: string };
    let requests = 0;
    let bytes = 0;
    async function get<T>(path: string): Promise<T> {
      const response = await app.inject({ method: 'GET', url: `/api/proxy${path}`, headers });
      expect(response.statusCode, `${path}: ${response.body.slice(0, 300)}`).toBe(200);
      requests += 1;
      bytes += response.rawPayload.byteLength;
      return response.json() as T;
    }
    async function measure<T>(label: string, read: () => Promise<T>): Promise<T> {
      requests = 0;
      bytes = 0;
      const started = performance.now();
      const result = await read();
      measurements.push({ read: label, requests, bytes, ms: Math.round(performance.now() - started) });
      return result;
    }
    /**
     * The traversal the UI uses for a complete collection
     * (`collectBoundedPages`, pages of 250, offsets from what each page
     * returned, refusing a repeated id or a shifting total), over the BFF.
     */
    function traverse(collection: string) {
      return collectBoundedPages<Row>(
        (offset, limit) => get<PaginatedResponse<Row>>(`/${collection}?offset=${offset}&limit=${limit}`),
        { pageSize: TRAVERSAL_PAGE, identity: (row) => row.id },
      );
    }
    const sorted = (ids: string[]) => [...ids].sort();
    const seededIds = (prefix: string) => sorted(Array.from({ length: RECORDS }, (_, index) => `${prefix}-${index}`));

    try {
      const registered = await admin('/namespaces', 'POST', { name: namespace });
      expect(registered.status, registered.text).toBe(201);
      const seedStarted = performance.now();
      const seeded = await admin('/batch?apply=sync', 'POST', {
        upstreams: Array.from({ length: RECORDS }, (_, index) => ({
          id: `scale-up-${index}`, name: `scale-up-${index}`, algorithm: 'round_robin',
          targets: [{ host: 'host.docker.internal', port: 9101, weight: 1 }],
        })),
        proxies: Array.from({ length: RECORDS }, (_, index) => ({
          id: `scale-proxy-${index}`, name: `scale-proxy-${index}`,
          listen_path: `/scale-${index}`, hosts: [], backend_scheme: 'http',
          backend_host: 'host.docker.internal', backend_port: 9101,
          upstream_id: `scale-up-${index}`, strip_listen_path: true,
        })),
        consumers: [],
        plugin_configs: [],
      });
      expect([200, 201], seeded.text.slice(0, 1000)).toContain(seeded.status);
      const seedMs = Math.round(performance.now() - seedStarted);

      const first = await measure('Proxy list, first page', () =>
        get<PaginatedResponse<Row>>(`/proxies?offset=0&limit=${LIST_PAGE}`));
      expect(first.pagination).toMatchObject({ offset: 0, total: RECORDS });
      expect(first.data).toHaveLength(LIST_PAGE);
      const last = await measure('Proxy list, last page', () =>
        get<PaginatedResponse<Row>>(`/proxies?offset=${RECORDS - LIST_PAGE}&limit=${LIST_PAGE}`));
      expect(last.pagination).toMatchObject({ offset: RECORDS - LIST_PAGE, total: RECORDS });
      expect(last.data).toHaveLength(LIST_PAGE);
      const opened = await measure('Open one proxy', () => get<Row>(`/proxies/scale-proxy-${RECORDS - 1}`));
      expect(opened.id).toBe(`scale-proxy-${RECORDS - 1}`);

      const proxies = await measure('Every proxy (traversal)', () => traverse('proxies'));
      expect(proxies).toMatchObject({ complete: true, total: RECORDS });
      expect(sorted(proxies.items.map((row) => row.id))).toEqual(seededIds('scale-proxy'));
      const upstreams = await measure('Every upstream (traversal)', () => traverse('upstreams'));
      expect(upstreams).toMatchObject({ complete: true, total: RECORDS });
      expect(sorted(upstreams.items.map((row) => row.id))).toEqual(seededIds('scale-up'));

      const report = {
        edge_image: process.env.FERRUM_EDGE_IMAGE ?? null,
        records_per_collection: RECORDS,
        seed_ms: seedMs,
        reads: measurements,
      };
      console.log(JSON.stringify(report, null, 2));
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
          `### Scale: ${RECORDS} proxies and ${RECORDS} upstreams through the BFF`,
          '',
          `Seeded with one \`POST /batch\` in ${seedMs} ms.`,
          '',
          '| Read | Requests | Response bytes | Elapsed (ms) |',
          '| --- | ---: | ---: | ---: |',
          ...measurements.map((entry) => `| ${entry.read} | ${entry.requests} | ${entry.bytes} | ${entry.ms} |`),
          '',
        ].join('\n'));
      }
    } finally {
      try {
        // A refused cascade would leave 2,000 resources on the shared job
        // gateway, so it fails the test rather than passing silently.
        const cleanup = await admin(`/namespaces/${namespace}?confirm=true`, 'DELETE');
        expect([200, 204], `namespace cleanup: ${cleanup.text.slice(0, 300)}`).toContain(cleanup.status);
      } finally {
        await app.close();
      }
    }
  },
  600_000,
);
