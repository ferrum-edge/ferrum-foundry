import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from './auth-types.js';

const principal: AuthPrincipal = {
  subject: 'settings-test',
  displayName: 'Settings test',
  role: 'admin',
  namespaces: ['tenant-a'],
  authMode: 'static',
};

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FERRUM_ADMIN_URL', 'http://127.0.0.1:9000');
  vi.stubEnv('FERRUM_JWT_SECRET', 'settings-test-signing-secret-long-enough');
  vi.stubEnv('FERRUM_BFF_AUTH_TOKEN', 'settings-test-session-token-long-enough');
  vi.stubEnv('FERRUM_ALLOW_RUNTIME_SETTINGS', 'true');
  vi.stubEnv('FERRUM_ADMIN_ALLOWED_ORIGINS', 'http://127.0.0.1:9000');
  vi.stubEnv('FERRUM_JWT_AUDIENCE', 'old-audience');
  vi.stubEnv('FERRUM_JWT_NAMESPACES', 'tenant-a');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runtime audience clearing', () => {
  it('removes the old audience from subsequent JWTs and public settings', async () => {
    const config = await import('./config.js');
    const { generateToken } = await import('./jwt.js');
    const before = await generateToken(config.loadConfig(), principal);
    expect(decodeJwt(before).aud).toBe('old-audience');
    expect(config.getPublicRuntimeConfig()).toMatchObject({
      jwtAudience: 'old-audience',
      jwtNamespaces: ['tenant-a'],
    });

    // This is the explicit clear payload asserted by SettingsForm.test.tsx.
    await config.updateRuntimeConfig({ jwtAudience: '', jwtNamespaces: [] });

    const after = await generateToken(config.loadConfig(), principal);
    expect(after).not.toBe(before);
    expect(decodeJwt(after)).not.toHaveProperty('aud');
    expect(config.getPublicRuntimeConfig().jwtAudience).toBeUndefined();
    expect(config.getPublicRuntimeConfig().jwtNamespaces).toBeUndefined();
    const response = JSON.parse(JSON.stringify(config.getPublicRuntimeConfig()));
    expect(response).not.toHaveProperty('jwtAudience');
    expect(response).not.toHaveProperty('jwtNamespaces');
  });
});
