import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Env must be set before importing auth.ts (which loads config at first call).
const BFF_TOKEN = 'unit-test-bff-token-1234567890ABC';
const ADMIN_URL = 'http://127.0.0.1:9999';
const JWT_SECRET = 'unit-test-secret-do-not-leak';

const ENV_KEYS = [
  'FERRUM_ADMIN_URL',
  'FERRUM_JWT_SECRET',
  'FERRUM_BFF_AUTH_TOKEN',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

let requireAdminAuth: typeof import('./auth.js').requireAdminAuth;

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  process.env.FERRUM_ADMIN_URL = ADMIN_URL;
  process.env.FERRUM_JWT_SECRET = JWT_SECRET;
  process.env.FERRUM_BFF_AUTH_TOKEN = BFF_TOKEN;

  const mod = await import('./auth.js');
  requireAdminAuth = mod.requireAdminAuth;
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
  app.get('/protected', { preHandler: requireAdminAuth }, async () => ({
    ok: true,
  }));
  return app;
}

describe('requireAdminAuth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/protected' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the header does not use the Bearer scheme', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when Bearer is present but the token is empty', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer ' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the token is wrong', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer this-is-not-the-token-xxxxxxxxx' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('reaches the protected handler when the correct token is supplied', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${BFF_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('accepts lowercase "bearer" prefix (case-insensitive)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `bearer ${BFF_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('accepts uppercase "BEARER" prefix (case-insensitive)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `BEARER ${BFF_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('returns 401 (without throwing) when the provided token is shorter than the configured token', async () => {
    const app = await buildApp();
    try {
      // safeEqual must run a fixed-length compare to avoid leaking length via
      // timing — but functionally, mismatched lengths must just yield 401.
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer short' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the provided token is longer than the configured token', async () => {
    const app = await buildApp();
    try {
      const tooLong = `${BFF_TOKEN}-extra-suffix`;
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${tooLong}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });
});
