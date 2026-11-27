import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

/**
 * The CP + DP pair qualifies only if a change made through Foundry on the
 * control plane reaches the data plane. This creates one proxy through the BFF
 * on the CP, then requires, within a bounded wait, that the DP's admin API
 * serves it through a second BFF and that the DP routes a request through it
 * to the demo backend. It also checks that each side reports the other as
 * connected (`/cluster`). The proxy stays for the page reads that follow.
 */

const PROXY_ID = 'modes-cpdp-proxy';
const LISTEN_PATH = '/modes-cpdp';
const DEADLINE_MS = 90_000;
const POLL_MS = 1_000;

async function eventually<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${what} did not happen within ${DEADLINE_MS / 1000}s${last ? `: ${String(last)}` : ''}`);
}

async function bff(adminUrl: string) {
  const proof = 'hosted-cp-dp-sync-proof-long-enough-xx';
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', adminUrl);
  vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
  vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
  vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
  vi.resetModules();
  const { buildApp } = await import('../app.js');
  const app = await buildApp({ serveStatic: false, logger: false });
  const namespace = process.env.FERRUM_NAMESPACE ?? 'ferrum-foundry-demo';
  async function session(grants?: string) {
    const identity: Record<string, string> = {
      'x-ferrum-auth-secret': proof,
      'x-forwarded-user': `cp-dp-sync-admin-${grants ?? 'fleet'}`,
      'x-ferrum-role': 'admin',
      ...(grants ? { 'x-ferrum-namespaces': grants } : {}),
    };
    const opened = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity });
    expect(opened.statusCode, opened.body).toBe(200);
    const { csrfToken } = opened.json() as { csrfToken?: string };
    return {
      ...identity,
      cookie: opened.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-ferrum-namespace': namespace,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    };
  }
  return { app, scoped: await session(namespace), fleet: await session() };
}

// Executed by the Gateway Modes (cp-dp) CI job only, against its disposable pair.
it.runIf(process.env.FERRUM_CP_DP_SYNC_GATEWAY_CONTRACT === 'true')(
  'a proxy created through Foundry on the control plane is served by the data plane',
  async () => {
    const cpUrl = process.env.FERRUM_CP_ADMIN_URL!;
    const dpUrl = process.env.FERRUM_DP_ADMIN_URL!;
    const dataPlane = process.env.FERRUM_DP_PROXY_URL ?? 'http://127.0.0.1:8000';
    const backendHost = process.env.FERRUM_DEMO_BACKEND_HOST ?? 'host.docker.internal';
    const report: string[] = [];

    const cp = await bff(cpUrl);
    try {
      const connected = await eventually('the CP listing a connected data plane', async () => {
        const answer = await cp.app.inject({ method: 'GET', url: '/api/proxy/cluster', headers: cp.fleet });
        const body = answer.json() as { mode?: string; connected_data_planes?: number };
        return answer.statusCode === 200 && body.mode === 'cp' && (body.connected_data_planes ?? 0) >= 1
          ? body.connected_data_planes : undefined;
      });
      report.push(`CP /cluster: ${connected} connected data plane(s)`);

      const created = await cp.app.inject({
        method: 'POST',
        url: '/api/proxy/proxies',
        headers: { ...cp.scoped, 'content-type': 'application/json' },
        payload: {
          id: PROXY_ID,
          name: 'modes cp-dp proxy',
          listen_path: LISTEN_PATH,
          hosts: [],
          backend_scheme: 'http',
          backend_host: backendHost,
          backend_port: 9101,
          strip_listen_path: true,
          preserve_host_header: false,
          backend_connect_timeout_ms: 1500,
          backend_read_timeout_ms: 5000,
          backend_write_timeout_ms: 5000,
          backend_tls_verify_server_cert: true,
          auth_mode: 'single',
          plugins: [],
          frontend_tls: false,
          passthrough: false,
          udp_idle_timeout_seconds: 60,
          allowed_ws_origins: [],
          response_body_mode: 'stream',
        },
      });
      expect([201, 200], `POST /proxies on the CP: ${created.statusCode} ${created.body}`).toContain(created.statusCode);
      report.push(`CP POST /proxies: ${created.statusCode}`);
    } finally {
      await cp.app.close();
    }

    const dp = await bff(dpUrl);
    try {
      const control = await eventually('the DP reporting its control plane online', async () => {
        const answer = await dp.app.inject({ method: 'GET', url: '/api/proxy/cluster', headers: dp.fleet });
        const body = answer.json() as { mode?: string; control_plane?: { status?: string } | null };
        return answer.statusCode === 200 && body.mode === 'dp' && body.control_plane?.status === 'online'
          ? body.control_plane.status : undefined;
      });
      report.push(`DP /cluster: control plane ${control}`);

      const served = await eventually('the DP admin API serving the proxy', async () => {
        const answer = await dp.app.inject({
          method: 'GET', url: `/api/proxy/proxies/${PROXY_ID}`, headers: dp.scoped,
        });
        return answer.statusCode === 200 && (answer.json() as { id?: string }).id === PROXY_ID
          ? answer.statusCode : undefined;
      });
      report.push(`DP GET /proxies/${PROXY_ID} through the BFF: ${served}`);
    } finally {
      await dp.app.close();
    }

    const routed = await eventually('the DP routing a request through the proxy', async () => {
      const response = await fetch(new URL(`${LISTEN_PATH}/`, dataPlane), { signal: AbortSignal.timeout(10_000) });
      await response.arrayBuffer();
      return response.status === 200 ? response.status : undefined;
    });
    report.push(`DP data plane GET ${LISTEN_PATH}/: ${routed}`);

    const summary = ['### CP to DP through Foundry', '', ...report.map((line) => `- ${line}`), ''].join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  },
  300_000,
);
