import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { isGatewayHealthSnapshot } from '../../shared/health-snapshot.js';

/**
 * Every read a Foundry page makes, sent through the BFF as an unrestricted
 * admin, against a gateway in one mode. A page may treat `404`/`503` as
 * "not on this gateway" only for the families the client already treats as
 * optional (`SILENT_PROBE_PATTERNS` in `src/api/client.ts`); every other read
 * must answer `200` with a body the page can parse.
 */
interface PageRead {
  page: string;
  path: string;
  /** A mode-dependent surface: `404`/`503` means not served by this gateway. */
  optional?: true;
  /** Prometheus text, not JSON. */
  text?: true;
  /**
   * Sent by a namespace-scoped session. With Edge's
   * FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM an unrestricted session cannot use
   * namespace routes, and a scoped one cannot use fleet routes, so an
   * operator uses one identity per kind (docs/authentication.md).
   */
  scoped?: true;
}

const WHITESPACE_RUNS_PATTERN = /\s+/g;
const PIPE_PATTERN = /\|/g;

const PAGE = '?offset=0&limit=50';
const PAGE_READS: PageRead[] = [
  { page: 'Proxies', path: `/proxies${PAGE}`, scoped: true },
  { page: 'Upstreams', path: `/upstreams${PAGE}`, scoped: true },
  { page: 'Consumers', path: `/consumers${PAGE}`, scoped: true },
  { page: 'Plugins', path: `/plugins/config${PAGE}`, scoped: true },
  { page: 'Plugins', path: '/plugins' },
  { page: 'Settings', path: `/namespaces${PAGE}` },
  { page: 'Settings', path: '/backup', scoped: true },
  { page: 'API Specs', path: `/api-specs${PAGE}`, optional: true, scoped: true },
  { page: 'Audit', path: `/audit${PAGE}`, optional: true, scoped: true },
  { page: 'Dashboard, Metrics', path: '/admin/metrics' },
  { page: 'Metrics', path: '/metrics', text: true },
  { page: 'Metrics', path: '/metrics/runtime' },
  { page: 'Metrics', path: '/overload' },
  { page: 'Metrics', path: '/charges?format=json', optional: true },
  { page: 'Metrics', path: '/charges/sink/status', optional: true },
  { page: 'Cluster', path: '/cluster' },
  { page: 'Cluster', path: '/backend-capabilities', optional: true },
  { page: 'TLS', path: `/admin/tls/inventory${PAGE}` },
  { page: 'TLS', path: `/admin/tls/events${PAGE}` },
  { page: 'TLS', path: `/admin/tls/certificates${PAGE}` },
  { page: 'TLS', path: `/admin/tls/ca-bundles${PAGE}` },
  { page: 'TLS', path: `/admin/tls/crls${PAGE}` },
  { page: 'TLS', path: `/admin/tls/ocsp-responses${PAGE}` },
  { page: 'TLS', path: `/admin/tls/jwks${PAGE}` },
  { page: 'TLS', path: `/admin/tls/acme/certificates${PAGE}` },
  { page: 'TLS', path: `/admin/tls/acme/orders${PAGE}` },
  { page: 'TLS', path: `/admin/tls/acme/accounts${PAGE}` },
  { page: 'Mesh', path: `/gateway-trust-bundles${PAGE}`, optional: true, scoped: true },
  { page: 'Mesh', path: '/gateway-trust/status', optional: true, scoped: true },
  { page: 'Mesh', path: '/mesh/service-graph', optional: true },
  { page: 'Mesh', path: '/mesh/egress-scope', optional: true },
  { page: 'Mesh', path: '/mesh/federation', optional: true },
  { page: 'Mesh', path: '/mesh/remote-clusters', optional: true },
  { page: 'Mesh', path: '/mesh/runtime-overlay', optional: true },
  { page: 'Mesh', path: '/mesh/config-drift', optional: true },
  { page: 'Mesh', path: '/mesh/slice-drift', optional: true },
  { page: 'Mesh', path: '/mesh/policy-denies/recent', optional: true },
  { page: 'Mesh', path: '/node-waypoint/identities', optional: true },
  { page: 'Mesh', path: '/service-waypoint/services', optional: true },
];

interface Target {
  mode: string;
  adminUrl: string;
}

/** `mode@url,mode@url` from FERRUM_PAGE_READ_TARGETS. */
function targets(): Target[] {
  return (process.env.FERRUM_PAGE_READ_TARGETS ?? '').split(',').filter(Boolean).map((entry) => {
    const at = entry.indexOf('@');
    return { mode: entry.slice(0, at), adminUrl: entry.slice(at + 1) };
  });
}

// Executed by the Gateway Modes CI job only, against its disposable gateway.
it.runIf(process.env.FERRUM_PAGE_READS_GATEWAY_CONTRACT === 'true')(
  'answers every page read through the BFF in this gateway mode',
  async () => {
    const namespace = process.env.FERRUM_NAMESPACE ?? 'ferrum-foundry-demo';
    const failures: string[] = [];
    const rows: string[] = [];
    for (const target of targets()) {
      const proof = 'hosted-page-read-proof-long-enough-xx';
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('FERRUM_ADMIN_URL', target.adminUrl);
      vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
      vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
      vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
      vi.resetModules();
      const { buildApp } = await import('../app.js');
      const app = await buildApp({ serveStatic: false, logger: false });
      try {
        // Administrators: an unrestricted one for fleet reads, and one granted
        // the namespace for namespace reads.
        async function signIn(grants?: string) {
          const identity: Record<string, string> = {
            'x-ferrum-auth-secret': proof, 'x-forwarded-user': `page-read-admin-${grants ?? 'fleet'}`,
            'x-ferrum-role': 'admin', ...(grants ? { 'x-ferrum-namespaces': grants } : {}),
          };
          const opened = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity });
          expect(opened.statusCode).toBe(200);
          return {
            ...identity,
            cookie: opened.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
            'x-ferrum-namespace': namespace,
          };
        }
        const headers = await signIn();
        const scopedHeaders = await signIn(namespace);

        const health = await app.inject({ method: 'GET', url: '/api/proxy/health', headers });
        const snapshot = health.json();
        rows.push(`| ${target.mode} | Status | \`/health\` | ${health.statusCode} | mode \`${snapshot?.mode}\` |`);
        if (!isGatewayHealthSnapshot(snapshot) || ![200, 503].includes(health.statusCode)) {
          failures.push(`${target.mode} /health: ${health.statusCode} without a valid snapshot`);
        } else if (snapshot.mode !== target.mode) {
          failures.push(`${target.mode} /health: reports mode ${String(snapshot.mode)}`);
        }

        for (const read of PAGE_READS) {
          const response = await app.inject({
            method: 'GET', url: `/api/proxy${read.path}`, headers: read.scoped ? scopedHeaders : headers,
          });
          const status = response.statusCode;
          let note = '';
          if (status === 200) {
            if (!read.text) {
              try {
                JSON.parse(response.body);
              } catch {
                note = 'unparseable JSON';
                failures.push(`${target.mode} ${read.path}: 200 with unparseable JSON`);
              }
            }
          } else if (read.optional && (status === 404 || status === 503)) {
            note = 'not served by this gateway';
          } else {
            let detail = response.body.slice(0, 160).replace(WHITESPACE_RUNS_PATTERN, ' ');
            try {
              const error = (response.json() as { error?: unknown }).error;
              if (typeof error === 'string') detail = error.slice(0, 160);
            } catch {
              // Keep the raw prefix.
            }
            note = detail;
            failures.push(`${target.mode} ${read.page} ${read.path}: ${status} ${detail}`);
          }
          rows.push(`| ${target.mode} | ${read.page} | \`${read.path.split('?')[0]}\` | ${status} | ${note.replace(PIPE_PATTERN, '\\|')} |`);
        }
      } finally {
        await app.close();
      }
    }

    const report = [
      `### Page reads through the BFF: ${targets().map((target) => target.mode).join(', ')}`,
      '',
      '| Mode | Page | Read | Status | Note |',
      '| --- | --- | --- | ---: | --- |',
      ...rows,
      '',
    ].join('\n');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    expect(failures, failures.join('\n')).toEqual([]);
  },
  300_000,
);
