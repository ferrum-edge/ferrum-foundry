import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'runtime-ca-static-login-fixture-long-enough';
let directory: string;
let upstream: Server | undefined;
let app: FastifyInstance | undefined;
let headers: Record<string, string>;
let second: { key: Buffer; cert: Buffer };
let selectedPath: string;

function certificate(version: string) {
  const path = join(directory, version);
  mkdirSync(path);
  // Disposable hosted-CI certificates only; no external services or trust stores.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(path, 'key.pem'), '-out', join(path, 'ca.pem'),
  ], { stdio: 'ignore' });
  return { key: readFileSync(join(path, 'key.pem')), cert: readFileSync(join(path, 'ca.pem')) };
}

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  directory = mkdtempSync(join(tmpdir(), 'foundry-runtime-ca-'));
  const first = certificate('v1');
  second = certificate('v2');
  symlinkSync('v1', join(directory, '..data'));
  symlinkSync('..data/ca.pem', join(directory, 'ca.pem'));
  selectedPath = join(directory, 'ca.pem');
  upstream = createServer(first, (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `https://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test', FERRUM_ADMIN_URL: origin, FERRUM_ADMIN_ALLOWED_ORIGINS: origin,
    FERRUM_TLS_CA_PATH: selectedPath, FERRUM_TLS_CA_ROOT: directory,
    FERRUM_ALLOW_RUNTIME_SETTINGS: 'true', FERRUM_AUTH_MODE: 'static',
    FERRUM_JWT_SECRET: 'runtime-ca-signing-fixture-secret-long-enough',
    FERRUM_BFF_AUTH_TOKEN: TOKEN, FERRUM_SECURE_COOKIES: 'false',
  })) vi.stubEnv(key, value);
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN } });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': login.json().csrfToken as string,
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function probe() {
  const response = await app!.inject({ method: 'GET', url: '/api/proxy/echo', headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
}

describe('validated runtime CA selection', () => {
  it.each([false, true])('follows projected rotation after runtime selection=%s and old-directory cleanup', async (runtimeSelection) => {
    await probe();
    if (runtimeSelection) {
      const saved = await app!.inject({ method: 'PUT', url: '/api/settings', headers, payload: { tlsCaPath: selectedPath } });
      expect(saved.statusCode).toBe(200);
      expect((await import('./config.js')).loadConfig().tlsCaPath).toBe(selectedPath);
      await probe();
    }
    symlinkSync('v2', join(directory, '..next'));
    renameSync(join(directory, '..next'), join(directory, '..data'));
    rmSync(join(directory, 'v1'), { recursive: true });
    upstream!.setSecureContext(second);
    upstream!.closeIdleConnections();
    // Advance only the CA cache's clock, without waiting on wall time.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_500);
    await probe();
  });

  it('rejects invalid settings atomically and keeps the working HTTPS connection', async () => {
    await probe();
    const { getRuntimeConfig } = await import('./config.js');
    const before = getRuntimeConfig();
    const invalidPath = join(directory, 'invalid.pem');
    for (const pem of [
      'not a PEM certificate',
      '-----BEGIN CERTIFICATE-----\ntruncated',
      '-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----',
    ]) {
      writeFileSync(invalidPath, pem);
      const response = await app!.inject({
        method: 'PUT', url: '/api/settings', headers,
        payload: { jwtIssuer: 'must-not-publish', tlsCaPath: invalidPath },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('FERRUM_BFF_INVALID_SETTINGS');
      expect(response.body).not.toContain(directory);
      expect(getRuntimeConfig()).toEqual(before);
      await probe();
    }
  });

  it('applies the same certificate validation to startup configuration', async () => {
    const path = join(directory, 'invalid.pem');
    writeFileSync(path, 'not a PEM certificate');
    vi.stubEnv('FERRUM_TLS_CA_PATH', path);
    vi.resetModules();
    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow('TLS CA bundle must contain valid PEM certificates');
  });
});
