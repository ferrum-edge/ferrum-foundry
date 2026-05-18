import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// Required env must be set before importing the plugin — config.ts
// reads it at module load time.
const BFF_TOKEN = 'test-bff-token-must-be-at-least-16-chars';
process.env.FERRUM_ADMIN_URL ??= 'http://127.0.0.1:9999';
process.env.FERRUM_JWT_SECRET ??= 'super-secret-test-value-do-not-leak';
process.env.FERRUM_BFF_AUTH_TOKEN ??= BFF_TOKEN;

const { default: settingsPlugin } = await import('./settings.js');

const AUTH_HEADERS = { authorization: `Bearer ${process.env.FERRUM_BFF_AUTH_TOKEN}` };

async function buildApp() {
  const app = Fastify();
  await app.register(settingsPlugin);
  return app;
}

describe('GET /api/settings', () => {
  test('requires bearer auth', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test('omits jwtSecret from the response body', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);

      const body = res.json() as Record<string, unknown>;
      assert.equal(
        'jwtSecret' in body,
        false,
        'jwtSecret must not appear in the response',
      );
      assert.equal(
        JSON.stringify(body).includes('super-secret-test-value'),
        false,
        'response must not contain the secret value anywhere',
      );
      assert.equal(typeof body.adminUrl, 'string');
    } finally {
      await app.close();
    }
  });
});

describe('PUT /api/settings', () => {
  test('requires bearer auth', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { jwtIssuer: 'whatever' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test('rejects jwtSecret in the payload', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtSecret: 'attacker-chosen-value' },
      });
      assert.equal(res.statusCode, 400);

      const body = res.json() as { error?: string };
      assert.match(body.error ?? '', /jwtSecret/);
    } finally {
      await app.close();
    }
  });

  test('rejects jwtSecret even when other fields are present', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtIssuer: 'ok', jwtSecret: 'attacker-chosen-value' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test('omits jwtSecret from the success response', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: AUTH_HEADERS,
        payload: { jwtIssuer: 'updated-issuer' },
      });
      assert.equal(res.statusCode, 200);

      const body = res.json() as Record<string, unknown>;
      assert.equal('jwtSecret' in body, false);
      assert.equal(body.jwtIssuer, 'updated-issuer');
      assert.equal(
        JSON.stringify(body).includes('super-secret-test-value'),
        false,
      );
    } finally {
      await app.close();
    }
  });
});
