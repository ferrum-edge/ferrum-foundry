import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  schema: null as string | null,
  missing: false,
  reads: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const readFile = original.readFileSync as (...args: any[]) => any;
  return {
    ...original,
    readFileSync: ((path: any, ...rest: any[]) => {
      const target = String(path);
      if (target.includes('service-manifest/v1.schema.json')) {
        state.reads += 1;
        if (state.missing) {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        }
        if (state.schema !== null) return state.schema;
      }
      return readFile(path, ...rest);
    }) as typeof original.readFileSync,
  };
});

const proof = 'test-trusted-proxy-shared-proof-long-enough';
const disabledLog = 'Service manifest preview is disabled';

async function buildDisabledApp() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', 'http://127.0.0.1:9999');
  vi.stubEnv('FERRUM_JWT_SECRET', 'test-signing-secret-long-enough-123456789');
  vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
  vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
  vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
  // loadConfig caches its base configuration, so each build needs a fresh
  // module graph. It also makes the memoized schema outcome fresh per build.
  vi.resetModules();
  const { buildApp } = await import('../app.js');
  const logs: string[] = [];
  const app = await buildApp({
    serveStatic: false,
    logger: { level: 'error', stream: { write: (chunk: string) => { logs.push(chunk); } } },
  });
  return { app, logs };
}

function previewRequest() {
  return {
    method: 'POST' as const,
    url: '/api/service-manifest/preview',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  };
}

describe('service manifest schema unavailable at startup', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.unstubAllEnvs();
    state.missing = false;
    state.schema = null;
    state.reads = 0;
  });

  it('starts the BFF and disables only the preview when the schema file is missing', async () => {
    state.missing = true;
    const built = await buildDisabledApp();
    app = built.app;
    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    const response = await app.inject(previewRequest());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Service manifest preview is unavailable',
      code: 'FERRUM_BFF_MANIFEST_SCHEMA_UNAVAILABLE',
    });
    // The failure is reported once, at startup, and only for this route.
    expect(built.logs.join('').split(disabledLog)).toHaveLength(2);
  });

  it('starts the BFF and disables only the preview on an unknown schema keyword', async () => {
    state.schema = JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
      unknownKeyword: true,
    });
    const built = await buildDisabledApp();
    app = built.app;
    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    const response = await app.inject(previewRequest());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Service manifest preview is unavailable',
      code: 'FERRUM_BFF_MANIFEST_SCHEMA_UNAVAILABLE',
    });
    expect(built.logs.join('').split(disabledLog)).toHaveLength(2);
    // The outcome is memoized: further calls reuse the recorded failure and
    // never read or compile the schema again.
    const { serviceManifestSchema } = await import('../service-manifest-schema.js');
    expect(() => serviceManifestSchema()).toThrow('could not be loaded or compiled');
    expect(() => serviceManifestSchema()).toThrow('could not be loaded or compiled');
    expect(state.reads).toBe(1);
  });
});