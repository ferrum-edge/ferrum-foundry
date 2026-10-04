import { readFileSync, readdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch as upstreamFetch } from 'undici';
import { MANIFEST_BODY_LIMIT, TLS_PATH_REDACTION } from '../service-manifest.js';

vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn(() => { throw new Error('Preview contacted an upstream'); }),
}));

const root = new URL(
  '../../contracts/ferrum-contracts/fixtures/service-manifest/', import.meta.url,
);
const fixtures = (kind: string) => readdirSync(new URL(`${kind}/`, root)).sort().map((name) => ({
  name, body: JSON.parse(readFileSync(new URL(`${kind}/${name}`, root), 'utf8')),
}));
const valid = fixtures('valid');
const invalid = fixtures('invalid');
const secret = 'preview-credential-canary-123456789';
const unknownKey = 'unreviewed-secret-field';
let app: FastifyInstance;
let logs = '';
const proof = 'test-trusted-proxy-shared-proof-long-enough';

function identity(role = 'viewer', grants = 'ferrum,retail') {
  return {
    'x-ferrum-auth-secret': proof,
    'x-forwarded-user': 'manifest-reviewer',
    'x-ferrum-role': role,
    'x-ferrum-namespaces': grants,
  };
}

async function headers(
  role = 'viewer', grants = 'ferrum,retail', namespace = 'ferrum', target = app,
) {
  const principal = identity(role, grants);
  const session = await target.inject({ method: 'GET', url: '/api/auth/session', headers: principal });
  expect(session.statusCode).toBe(200);
  return {
    ...principal,
    cookie: session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': session.json().csrfToken as string,
    'x-ferrum-namespace': namespace,
    'content-type': 'application/json',
  };
}

async function preview(body: unknown, namespace = 'ferrum', role = 'viewer') {
  return app.inject({
    method: 'POST', url: '/api/service-manifest/preview',
    headers: await headers(role, 'ferrum,retail', namespace),
    payload: JSON.stringify(body),
  });
}

function expectSafeLogs(status: number) {
  // Positive assertions prove the real logger ran before auth/parser rejection.
  expect(logs).toContain('"req":{"method":"POST","url":"/api/service-manifest/preview"}');
  expect(logs).toContain(`"statusCode":${status}`);
  expect(logs).toContain('"msg":"Service manifest request"');
  expect(logs).not.toContain(secret);
  expect(logs).not.toContain(unknownKey);
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', 'http://127.0.0.1:9999');
  vi.stubEnv('FERRUM_JWT_SECRET', 'test-signing-secret-long-enough-123456789');
  vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
  vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
  vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
  vi.resetModules();
  const { buildApp } = await import('../app.js');
  app = await buildApp({ serveStatic: false, logger: {
    level: 'debug', stream: { write: (chunk: string) => { logs += chunk; } },
  } });
});

beforeEach(() => {
  vi.clearAllMocks();
  logs = '';
});

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

describe('authenticated service manifest preview through the registered BFF route', () => {
  it.each(valid)('consumes shared valid fixture $name without side effects', async ({ body }) => {
    const response = await preview(body, body.gateway?.namespace ?? 'ferrum');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      readOnly: true, summary: { service: body.service.name },
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.body.length).toBeLessThan(16 * 1024);
  });

  it.each(invalid)('rejects shared invalid fixture $name with a bounded error', async ({ body }) => {
    const response = await preview(body, body.gateway?.namespace ?? 'ferrum');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Manifest does not match the supported v1 schema or preview normalization',
      code: 'FERRUM_BFF_MANIFEST_INVALID',
    });
    expect(response.body.length).toBeLessThan(256);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'operator', 'admin'])('allows %s to review resources', async (role) => {
    const response = await preview(valid[0].body, 'ferrum', role);
    expect(response.statusCode).toBe(200);
    expect(response.json().desired.proxy.id).toBe('orders-api');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('denies unauthenticated and invalid-CSRF bodies before parsing', async () => {
    const anonymous = await app.inject({
      method: 'POST', url: '/api/service-manifest/preview', payload: `{${secret}`,
      headers: { 'content-type': 'application/json' },
    });
    expect(anonymous.statusCode).toBe(401);
    const csrf = await headers();
    csrf['x-csrf-token'] = 'incorrect';
    const refused = await app.inject({
      method: 'POST', url: '/api/service-manifest/preview', headers: csrf, payload: `{${secret}`,
    });
    expect(refused.statusCode).toBe(403);
    expect(anonymous.body + refused.body + logs).not.toContain(secret);
  });

  it('never uses the body or agents namespace as an authorization grant', async () => {
    const headerDenied = await app.inject({
      method: 'POST', url: '/api/service-manifest/preview',
      headers: await headers('viewer', 'retail', 'ferrum'), payload: `{${secret}`,
    });
    expect(headerDenied.statusCode).toBe(403);
    const mismatch = await preview(valid[0].body, 'retail');
    expect(mismatch.statusCode).toBe(403);
    const agent = structuredClone(valid[0].body);
    agent.agents.namespace = 'tool_prefix_without_tenant_grant';
    expect((await preview(agent)).statusCode).toBe(200);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(logs).not.toContain(secret);
  });

  it('requires an exact namespace binding even for unrestricted admins', async () => {
    const binding = await headers('admin');
    delete (binding as Record<string, string>)['x-ferrum-namespaces'];
    const unbound: Record<string, string> = { ...binding };
    delete unbound['x-ferrum-namespace'];
    for (const value of [undefined, ' ferrum', 'ferrum,retail', 'bad/name']) {
      const response = await app.inject({
        method: 'POST', url: '/api/service-manifest/preview',
        headers: value === undefined ? unbound : { ...binding, 'x-ferrum-namespace': value },
        payload: JSON.stringify(valid[0].body),
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('uses shared defaults without coercion and preserves disabled agents', async () => {
    const body = structuredClone(valid[0].body);
    body.api = { public_path: '/' };
    body.agents = { enabled: false };
    body.gateway = { correlation_id: false };
    const response = await preview(body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: {
        protocols: ['http1', 'http2'], authMode: 'unspecified',
        agents: { enabled: false, endpointPath: '/mcp', namespace: 'orders-api' },
      },
      desired: {
        proxy: {
          strip_listen_path: true, backend_connect_timeout_ms: 2000,
          backend_read_timeout_ms: 30000, backend_write_timeout_ms: 30000,
        },
        plugin_configs: [], upstream: null,
      },
    });
    expect(response.json().desired.proxy).not.toHaveProperty('plugins');
    body.upstream.port = '8080';
    expect((await preview(body)).statusCode).toBe(400);
  });

  it('reuses static session cookies and CSRF rather than accepting a bearer token', async () => {
    const token = 'development-manifest-bff-token-long-enough';
    vi.stubEnv('FERRUM_AUTH_MODE', 'static');
    vi.stubEnv('FERRUM_BFF_AUTH_TOKEN', token);
    vi.stubEnv('FERRUM_JWT_NAMESPACES', 'ferrum');
    vi.stubEnv('FERRUM_JWT_ROLE', 'viewer');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const staticApp = await buildApp({ serveStatic: false, logger: false });
    try {
      const login = await staticApp.inject({
        method: 'POST', url: '/api/auth/login', payload: { token },
      });
      expect(login.statusCode).toBe(200);
      const authenticated = {
        cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
        'x-csrf-token': login.json().csrfToken as string,
        'x-ferrum-namespace': 'ferrum', 'content-type': 'application/json',
      };
      const payload = JSON.stringify(valid[0].body);
      const accepted = await staticApp.inject({
        method: 'POST', url: '/api/service-manifest/preview', headers: authenticated, payload,
      });
      expect(accepted.statusCode).toBe(200);
      const denied = await staticApp.inject({
        method: 'POST', url: '/api/service-manifest/preview',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload,
      });
      expect(denied.statusCode).toBe(401);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await staticApp.close();
      vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
    }
  });

  it('bounds raw bytes, nesting and parse errors without echoing excerpts', async () => {
    const binding = await headers();
    for (const [payload, status] of [
      [`{${secret}`, 400],
      ['['.repeat(9) + '0' + ']'.repeat(9), 400],
      [secret + 'x'.repeat(MANIFEST_BODY_LIMIT), 413],
    ] as const) {
      const response = await app.inject({
        method: 'POST', url: '/api/service-manifest/preview', headers: binding, payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body.length).toBeLessThan(256);
      expect(response.body + logs).not.toContain(secret);
      expectSafeLogs(status);
      expect(logs).toContain('"level":40');
    }
  });

  it.each([false, true])('redacts regular and malformed query input before auth=%s', async (auth) => {
    const binding = auth ? await headers() : { 'content-type': 'application/json' };
    for (const url of [
      `/api/service-manifest/preview?${unknownKey}=https://user:${secret}@example.test`,
      `/api/service-manifest/preview?${unknownKey}=%E0%A4%A&password=${secret}`,
      `/%61pi/service-man%69fest/preview?${unknownKey}=${secret}`,
    ]) {
      logs = '';
      const response = await app.inject({
        method: 'POST', url, headers: binding,
        payload: `{ "${unknownKey}": "${secret}"`,
      });
      const status = auth ? 400 : 401;
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(unknownKey);
      expectSafeLogs(status);
      expect(logs).not.toContain('%E0%A4%A');
      expect(upstreamFetch).not.toHaveBeenCalled();
    }
  });

  it.each(['/api/service-manifest/', '/%61pi/service-man%69fest/'])(
    'redacts malformed URI input below %s before route hooks', async (prefix) => {
      const response = await app.inject({
        method: 'POST',
        url: `${prefix}preview%E0%A4%A${secret}?${unknownKey}=${secret}`,
        headers: { 'content-type': 'application/json' }, payload: `{${secret}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        error: 'Manifest preview unavailable', code: 'FERRUM_BFF_MANIFEST_INPUT',
      });
      expect(response.body).not.toContain(secret);
      expectSafeLogs(400);
      expect(logs).not.toContain('%E0%A4%A');
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, 400], [413, 413], ['413', 500], [600, 500], [null, 500],
  ] as const)('bounds thrown status %s and redacts raw error logs', async (candidate, status) => {
    const { buildApp } = await import('../app.js');
    const failureApp = await buildApp({ serveStatic: false, logger: {
      level: 'debug', stream: { write: (chunk: string) => { logs += chunk; } },
    } });
    failureApp.addHook('preHandler', async (request, reply) => {
      if (request.url !== '/api/service-manifest/preview') return;
      const error = Object.assign(new Error(secret), {
        statusCode: candidate, cause: new Error(secret), request,
        data: { [unknownKey]: secret }, body: request.body,
      });
      // Exercise both Pino's error object serializer and its separate msg.
      request.log.error({ req: request, res: reply, err: error }, error.message);
      throw error;
    });
    try {
      const binding = await headers('viewer', 'ferrum,retail', 'ferrum', failureApp);
      logs = '';
      const response = await failureApp.inject({
        method: 'POST', url: '/api/service-manifest/preview', headers: binding,
        payload: JSON.stringify(valid[0].body),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: status === 413 ? 'Manifest exceeds the preview budget' : 'Manifest preview unavailable',
        code: 'FERRUM_BFF_MANIFEST_INPUT',
      });
      expectSafeLogs(status);
      expect(logs).toContain('"err":{"type":"Error","message":"Manifest preview unavailable"');
      expect(logs).toContain('"level":50');
      for (const field of ['cause', 'stack', 'data', 'body', 'headers']) {
        expect(logs).not.toContain(`"${field}":`);
      }
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(unknownKey);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await failureApp.close();
    }
  });

  it('preserves ordinary route logging and framework error classification', async () => {
    const { buildApp } = await import('../app.js');
    const ordinaryApp = await buildApp({ serveStatic: false, logger: {
      level: 'debug', stream: { write: (chunk: string) => { logs += chunk; } },
    } });
    ordinaryApp.get('/manifest-logging-probe', async () => ({ ok: true }));
    try {
      logs = '';
      const response = await ordinaryApp.inject('/manifest-logging-probe?ordinary=value');
      expect(response.statusCode).toBe(200);
      expect(logs).toContain('/manifest-logging-probe?ordinary=value');
      expect(logs).toContain('"msg":"incoming request"');
      const malformed = await ordinaryApp.inject('/manifest-logging-probe/%E0%A4%A');
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ code: 'FST_ERR_BAD_URL', statusCode: 400 });
    } finally {
      await ordinaryApp.close();
    }
  });

  it('bounds the serialized response in UTF-8 rather than returning oversized desired data', async () => {
    const body = structuredClone(valid[0].body);
    const path = `/${'界'.repeat(2000)}`;
    body.api.public_path = path;
    body.api.service_base_path = `${path}/`;
    body.agents.endpoint_path = `${path}/mcp`;
    const response = await preview(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Desired configuration exceeds the preview budget' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects non-JSON, queries and credential fields without fetching or logging', async () => {
    const binding = await headers();
    const contentType = await app.inject({
      method: 'POST', url: '/api/service-manifest/preview',
      headers: { ...binding, 'content-type': 'text/plain' }, payload: secret,
    });
    expect(contentType.statusCode).toBe(415);
    const query = await app.inject({
      method: 'POST', url: `/api/service-manifest/preview?fetch=https://user:${secret}@example.test`,
      headers: binding, payload: JSON.stringify(valid[0].body),
    });
    expect(query.statusCode).toBe(400);
    expect(query.body + logs).not.toContain(secret);
    const body = { ...valid[0].body, [unknownKey]: { password: secret } };
    const refused = await preview(body);
    expect(refused.statusCode).toBe(400);
    expect(refused.body + logs).not.toContain(secret);
    expect(refused.body + logs).not.toContain(unknownKey);
    expectSafeLogs(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('maps literal Edge fields and defaults; agents/auth remain informational', async () => {
    const body = valid.find((fixture) => fixture.name === 'plain-http.json')!.body;
    const response = await preview(body, 'retail');
    expect(response.json().desired).toEqual({
      proxy: {
        id: 'catalog', name: 'catalog-api', namespace: 'retail', listen_path: '/catalog',
        backend_scheme: 'http', backend_host: '127.0.0.1', backend_port: 8080,
        backend_path: '/v1', strip_listen_path: true, backend_connect_timeout_ms: 1000,
        backend_read_timeout_ms: 0, backend_write_timeout_ms: 15000,
        labels: { 'generated-by': 'ferrum-alloy' },
        plugins: [
          { plugin_config_id: 'catalog-correlation-id' },
          { plugin_config_id: 'catalog-otel-tracing' },
        ],
      },
      upstream: null,
      plugin_configs: [{
        id: 'catalog-correlation-id', plugin_name: 'correlation_id', namespace: 'retail',
        scope: 'proxy', proxy_id: 'catalog', enabled: true,
        config: { header_name: 'x-request-id', echo_downstream: true },
      }, {
        id: 'catalog-otel-tracing', plugin_name: 'otel_tracing', namespace: 'retail',
        scope: 'proxy', proxy_id: 'catalog', enabled: true,
        config: {
          endpoint: 'http://127.0.0.1:4318/v1/traces', service_name: 'ferrum-edge-retail',
          trace_context_trust: 'untrusted', include_url_path: false,
          root_sampling: 'ratio', root_sampling_ratio: 0.25,
        },
      }],
    });
    const agents = (await preview(valid[0].body)).json();
    expect(agents.summary.agents).toEqual({
      enabled: true, endpointPath: '/shop/mcp', namespace: 'orders',
    });
    expect(agents.desired.proxy).not.toHaveProperty('backend_protocol');
    expect(agents.desired.plugin_configs).toHaveLength(1);
  });

  it('maps health and TLS to the upstream, redacts paths and never reads them', async () => {
    const body = valid.find((fixture) => fixture.name === 'orders-api.json')!.body;
    const orders = structuredClone(body);
    orders.upstream.gateway_client_key_path = `/nonexistent/${secret}.key`;
    orders.service.description = secret;
    orders.api.openapi = `/nonexistent/${secret}.json`;
    const response = await preview(orders);
    expect(response.statusCode).toBe(200);
    const { desired, summary } = response.json();
    expect(desired.proxy.upstream_id).toBe('orders-api-upstream');
    expect(desired.proxy).not.toHaveProperty('backend_tls_client_key_path');
    expect(desired.proxy).not.toHaveProperty('backend_host');
    expect(desired.upstream).toMatchObject({
      algorithm: 'round_robin',
      targets: [{ host: 'orders.internal', port: 8443, weight: 1 }],
      health_checks: { active: {
        probe_type: 'http', http_path: '/readyz', interval_seconds: 10,
        timeout_ms: 2000, healthy_status_codes: [200], use_tls: true,
      } },
      backend_tls_verify_server_cert: true,
      backend_tls_client_key_path: TLS_PATH_REDACTION,
    });
    expect(desired.upstream.health_checks).not.toHaveProperty('enabled');
    expect(summary.tlsPathFields).toHaveLength(3);
    expect(response.body + logs).not.toContain(secret);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown schemaMajor', (body: any) => { body.schemaMajor = 1; }],
    ['nested unknown key', (body: any) => { body.upstream.password = secret; }],
    ['null optional field', (body: any) => { body.health = null; }],
    ['wrong schema', (body: any) => { body.schema = 'other'; }],
    ['unsupported major', (body: any) => { body.schema_version = '2.0'; }],
    ['derived ID overflow', (body: any) => { body.gateway = { proxy_id: 'a'.repeat(254) }; }],
    ['dot path', (body: any) => { body.api.public_path = '/a/./b'; }],
    ['percent path', (body: any) => { body.api.public_path = '/a/%62'; }],
    ['semicolon path', (body: any) => { body.api.public_path = '/a;b'; }],
    ['agents outside prefix', (body: any) => { body.agents.endpoint_path = '/shopping/mcp'; }],
    ['OTLP query credential', (body: any) => {
      body.gateway = { otel_endpoint: `https://otel.test/v1/traces?key=${secret}` };
    }],
    ['OTLP URL credentials', (body: any) => {
      body.gateway = { otel_endpoint: `https://user:${secret}@otel.test/v1/traces` };
    }],
    ['field size budget', (body: any) => { body.service.description = 'x'.repeat(2049); }],
  ])('rejects %s without side effects', async (_label, mutate) => {
    const body = structuredClone(valid[0].body);
    mutate(body);
    const response = await preview(body);
    expect(response.statusCode).toBe(400);
    expect(response.body + logs).not.toContain(secret);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
