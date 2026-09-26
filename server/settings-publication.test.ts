import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'settings-publication-login-fixture-long-enough';
let upstream: Server | undefined;
let app: FastifyInstance | undefined;
let held: ServerResponse | undefined;
let pollEntered: Promise<void>;
let entered: () => void;
let headers: Record<string, string>;
let base: string;
let holdReadiness: boolean;

beforeEach(async () => {
  holdReadiness = false;
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  pollEntered = new Promise((resolve) => { entered = resolve; });
  upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/config/apply-status' || (request.url === '/health' && holdReadiness)) {
      holdReadiness = false;
      held = response;
      entered();
      return;
    }
    if (request.url === '/health') {
      response.end('{"ready":false}');
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    response.end(JSON.stringify({ issuer: decodeJwt(token).iss }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test', FERRUM_ADMIN_URL: origin, FERRUM_ADMIN_ALLOWED_ORIGINS: origin,
    FERRUM_ALLOW_RUNTIME_SETTINGS: 'true', FERRUM_AUTH_MODE: 'static',
    FERRUM_JWT_SECRET: 'settings-publication-signing-fixture-long-enough',
    FERRUM_BFF_AUTH_TOKEN: TOKEN, FERRUM_SECURE_COOKIES: 'false',
  })) vi.stubEnv(key, value);
  const { buildApp } = await import('./app.js');
  app = await buildApp({ serveStatic: false, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN } });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
    'x-csrf-token': login.json().csrfToken as string,
  };
  const NativeRequest = globalThis.Request;
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, base) : input, init);
    }
  });
});

afterEach(async () => {
  held?.end('{"state":"pending"}');
  held = undefined;
  await app?.close();
  app = undefined;
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('settings publication and dispatcher retirement', () => {
  it('answers signing and transport saves while an ordinary long poll exceeds the client deadline', async () => {
    const { api } = await import('../src/api/client');
    const { loadConfig } = await import('./config.js');
    const { getDispatcher, closeDispatchers } = await import('./tls.js');
    const original = getDispatcher(loadConfig());
    let pollComplete = false;
    const poll = fetch(`${base}/api/proxy/config/apply-status`, { headers })
      .then(async (response) => { const body = await response.json(); pollComplete = true; return body; });
    await pollEntered;
    const release = setTimeout(() => held?.end('{"state":"pending"}'), 11_000);
    try {
      const signing = await api.put('api/settings', { headers, json: { jwtIssuer: 'accepted-issuer' } }).json<{ jwtIssuer: string }>();
      expect(signing.jwtIssuer).toBe('accepted-issuer');
      expect(pollComplete).toBe(false);
      expect(getDispatcher(loadConfig())).toBe(original);
      expect(original.closed).toBe(false);

      const transport = await api.put('api/settings', { headers, json: { connectTimeout: 6000 } }).json<{ connectTimeout: number }>();
      expect(transport.connectTimeout).toBe(6000);
      expect(pollComplete).toBe(false);
      const next = getDispatcher(loadConfig());
      expect(next).not.toBe(original);
      const probe = await fetch(`${base}/api/proxy/echo`, { headers });
      expect(await probe.json()).toEqual({ issuer: 'accepted-issuer' });

      let drained = false;
      const drain = closeDispatchers().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      expect(pollComplete).toBe(false);
      expect(await poll).toEqual({ state: 'pending' });
      await drain;
      expect(original.closed).toBe(true);
      expect(next.closed).toBe(true);
    } finally {
      clearTimeout(release);
      held?.end('{"state":"pending"}');
      await poll;
    }
  }, 20_000);

  it('isolates readiness probes and caches across settings generations', async () => {
    holdReadiness = true;
    const oldProbe = app!.inject({ method: 'GET', url: '/api/health/ready' }).then((response) => response);
    await pollEntered;
    const saved = await app!.inject({ method: 'PUT', url: '/api/settings', headers, payload: { jwtIssuer: 'new-generation' } });
    expect(saved.statusCode).toBe(200);
    const current = await app!.inject({ method: 'GET', url: '/api/health/ready' });
    expect(current.statusCode).toBe(503);
    expect(current.json().ready).toBe(false);
    held!.end('{"ready":true}');
    expect((await oldProbe).statusCode).toBe(200);
    const cached = await app!.inject({ method: 'GET', url: '/api/health/ready' });
    expect(cached.statusCode).toBe(503);
    expect(cached.json()).toEqual(current.json());
  });

  it('returns each accepted generation when concurrent completion order differs', async () => {
    const { registerRuntimeConfigListener, loadConfig } = await import('./config.js');
    const completions: (() => void)[] = [];
    const stop = registerRuntimeConfigListener(() => new Promise<void>((resolve) => completions.push(resolve)));
    try {
      const first = app!.inject({ method: 'PUT', url: '/api/settings', headers, payload: { jwtIssuer: 'first' } }).then((response) => response);
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      const second = app!.inject({ method: 'PUT', url: '/api/settings', headers, payload: { jwtIssuer: 'second' } }).then((response) => response);
      await vi.waitFor(() => expect(completions).toHaveLength(2));
      completions[1]();
      const secondResponse = await second;
      expect(secondResponse.statusCode).toBe(200);
      expect(secondResponse.json().jwtIssuer).toBe('second');
      completions[0]();
      const firstResponse = await first;
      expect(firstResponse.statusCode).toBe(200);
      expect(firstResponse.json().jwtIssuer).toBe('first');
      expect(loadConfig().jwtIssuer).toBe('second');
    } finally {
      stop();
      for (const complete of completions) complete();
    }
  });
});
