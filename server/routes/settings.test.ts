import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Required env must be set before importing the plugin — config.ts
// reads it at module load time.
const BFF_TOKEN = 'test-bff-token-must-be-at-least-16-chars';
const JWT_SECRET = 'super-secret-test-value-do-not-leak';
const ADMIN_URL = 'http://127.0.0.1:9999';

const ENV_KEYS = [
  'FERRUM_ADMIN_URL',
  'FERRUM_JWT_SECRET',
  'FERRUM_BFF_AUTH_TOKEN',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

const AUTH_HEADERS = { authorization: `Bearer ${BFF_TOKEN}` };

let settingsPlugin: typeof import('./settings.js').default;

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  process.env.FERRUM_ADMIN_URL = ADMIN_URL;
  process.env.FERRUM_JWT_SECRET = JWT_SECRET;
  process.env.FERRUM_BFF_AUTH_TOKEN = BFF_TOKEN;

  const mod = await import('./settings.js');
  settingsPlugin = mod.default;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const previous = envSnapshot[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(settingsPlugin);
  return app;
}

describe('GET /api/settings', () => {
  it('requires bearer auth', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('omits jwtSecret from the response body', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);

      const body = res.json() as Record<string, unknown>;
      expect('jwtSecret' in body).toBe(false);
      expect(JSON.stringify(body).includes(JWT_SECRET)).toBe(false);
      expect(typeof body.adminUrl).toBe('string');
    } finally {
      await app.close();
    }
  });
});

describe('PUT /api/settings', () => {
  it('requires bearer auth', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { jwtIssuer: 'whatever' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated requests before parsing the body', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('rejects jwtSecret in the payload', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtSecret: 'attacker-chosen-value' },
      });
      expect(res.statusCode).toBe(400);

      const body = res.json() as { error?: string };
      expect(body.error ?? '').toMatch(/jwtSecret/);
    } finally {
      await app.close();
    }
  });

  it('rejects jwtSecret even when other fields are present', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtIssuer: 'ok', jwtSecret: 'attacker-chosen-value' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('omits jwtSecret from the success response', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtIssuer: 'updated-issuer' },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json() as Record<string, unknown>;
      expect('jwtSecret' in body).toBe(false);
      expect(body.jwtIssuer).toBe('updated-issuer');
      expect(JSON.stringify(body).includes(JWT_SECRET)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
