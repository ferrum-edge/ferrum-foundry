import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import type { Config } from './config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    adminUrl: 'http://127.0.0.1:9000',
    jwtSecret: 'unit-test-secret-do-not-use-in-prod',
    jwtIssuer: 'ferrum-foundry-tests',
    jwtTtl: 3600,
    tlsCaPath: undefined,
    tlsVerify: true,
    connectTimeout: 5000,
    readTimeout: 60000,
    writeTimeout: 60000,
    port: 3001,
    bffAuthToken: 'unit-test-bff-token-do-not-use-in-prod',
    ...overrides,
  };
}

async function verify(
  token: string,
  secret: string,
  issuer = 'ferrum-foundry-tests',
): Promise<JWTPayload> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { issuer });
  return payload;
}

// jwt.ts memoizes the signed token at module scope, so re-import a fresh copy
// per test to keep cases independent.
async function loadGenerateToken(): Promise<
  (config: Config) => Promise<string>
> {
  vi.resetModules();
  const mod = await import('./jwt.js');
  return mod.generateToken;
}

describe('generateToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('signs a token that can be verified with the configured secret', async () => {
    const generateToken = await loadGenerateToken();
    const config = makeConfig();
    const token = await generateToken(config);

    // Three base64url segments separated by '.'.
    expect(token.split('.')).toHaveLength(3);

    const payload = await verify(token, config.jwtSecret);
    expect(payload.iss).toBe(config.jwtIssuer);
    expect(payload.sub).toBe('ferrum-foundry');
    expect(typeof payload.jti).toBe('string');
    expect((payload.jti as string).length).toBeGreaterThan(0);
  });

  it('uses HS256 in the protected header', async () => {
    const generateToken = await loadGenerateToken();
    const token = await generateToken(makeConfig());
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256' });
  });

  it('sets exp/iat/nbf consistent with the configured TTL', async () => {
    const generateToken = await loadGenerateToken();
    const config = makeConfig({ jwtTtl: 600 });
    const before = Math.floor(Date.now() / 1000);
    const token = await generateToken(config);
    const after = Math.floor(Date.now() / 1000);

    const payload = await verify(token, config.jwtSecret);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.nbf).toBe('number');
    expect(typeof payload.exp).toBe('number');

    const iat = payload.iat as number;
    const nbf = payload.nbf as number;
    const exp = payload.exp as number;

    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after);
    expect(nbf).toBe(iat);
    expect(exp - iat).toBe(config.jwtTtl);
  });

  it('fails to verify when a different secret is used', async () => {
    const generateToken = await loadGenerateToken();
    const config = makeConfig();
    const token = await generateToken(config);

    await expect(verify(token, 'wrong-secret')).rejects.toThrow();
  });

  it('reuses the cached token within its validity window', async () => {
    const generateToken = await loadGenerateToken();
    const config = makeConfig();
    const first = await generateToken(config);
    const second = await generateToken(config);
    expect(second).toBe(first);
  });
});
