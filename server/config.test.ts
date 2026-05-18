import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV_KEYS = [
  'FERRUM_ADMIN_URL',
  'FERRUM_JWT_SECRET',
  'FERRUM_BFF_AUTH_TOKEN',
  'FERRUM_JWT_ISSUER',
  'FERRUM_JWT_TTL',
  'FERRUM_TLS_CA_PATH',
  'FERRUM_TLS_VERIFY',
  'FERRUM_CONNECT_TIMEOUT',
  'FERRUM_READ_TIMEOUT',
  'FERRUM_WRITE_TIMEOUT',
  'PORT',
] as const;

function clearFerrumEnv(): void {
  for (const key of REQUIRED_ENV_KEYS) {
    delete process.env[key];
  }
}

function setValidEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.FERRUM_ADMIN_URL = 'http://127.0.0.1:9000';
  process.env.FERRUM_JWT_SECRET = 'unit-test-secret';
  process.env.FERRUM_BFF_AUTH_TOKEN = 'unit-test-bff-token-1234567890';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadConfigModule(): Promise<typeof import('./config.js')> {
  vi.resetModules();
  return await import('./config.js');
}

describe('config', () => {
  // Snapshot every Ferrum-related env var so tests can mutate process.env
  // freely without leaking into the rest of the suite.
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of REQUIRED_ENV_KEYS) {
      snapshot[key] = process.env[key];
    }
    clearFerrumEnv();
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV_KEYS) {
      const previous = snapshot[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  describe('loadConfig - required env vars', () => {
    it('throws when FERRUM_ADMIN_URL is missing', async () => {
      setValidEnv({ FERRUM_ADMIN_URL: undefined });
      const { loadConfig } = await loadConfigModule();
      expect(() => loadConfig()).toThrow(/FERRUM_ADMIN_URL/);
    });

    it('throws when FERRUM_JWT_SECRET is missing', async () => {
      setValidEnv({ FERRUM_JWT_SECRET: undefined });
      const { loadConfig } = await loadConfigModule();
      expect(() => loadConfig()).toThrow(/FERRUM_JWT_SECRET/);
    });

    it('throws when FERRUM_BFF_AUTH_TOKEN is missing', async () => {
      setValidEnv({ FERRUM_BFF_AUTH_TOKEN: undefined });
      const { loadConfig } = await loadConfigModule();
      expect(() => loadConfig()).toThrow(/FERRUM_BFF_AUTH_TOKEN/);
    });
  });

  describe('loadConfig - defaults', () => {
    it('applies sensible defaults when only required vars are set', async () => {
      setValidEnv();
      const { loadConfig } = await loadConfigModule();
      const cfg = loadConfig();

      expect(cfg.adminUrl).toBe('http://127.0.0.1:9000');
      expect(cfg.jwtSecret).toBe('unit-test-secret');
      expect(cfg.jwtIssuer).toBe('ferrum-edge');
      expect(cfg.jwtTtl).toBe(3600);
      expect(cfg.tlsCaPath).toBeUndefined();
      expect(cfg.tlsVerify).toBe(true);
      expect(cfg.connectTimeout).toBe(5000);
      expect(cfg.readTimeout).toBe(60000);
      expect(cfg.writeTimeout).toBe(60000);
      expect(cfg.port).toBe(3001);
    });

    it('parses numeric env vars as numbers', async () => {
      setValidEnv({
        FERRUM_JWT_TTL: '120',
        FERRUM_CONNECT_TIMEOUT: '1500',
        FERRUM_READ_TIMEOUT: '20000',
        FERRUM_WRITE_TIMEOUT: '25000',
        PORT: '4242',
      });
      const { loadConfig } = await loadConfigModule();
      const cfg = loadConfig();

      expect(cfg.jwtTtl).toBe(120);
      expect(cfg.connectTimeout).toBe(1500);
      expect(cfg.readTimeout).toBe(20000);
      expect(cfg.writeTimeout).toBe(25000);
      expect(cfg.port).toBe(4242);
    });

    it('treats FERRUM_TLS_VERIFY="false" as false and any other value as true', async () => {
      setValidEnv({ FERRUM_TLS_VERIFY: 'false' });
      const { loadConfig: loadDisabled } = await loadConfigModule();
      expect(loadDisabled().tlsVerify).toBe(false);

      setValidEnv({ FERRUM_TLS_VERIFY: 'true' });
      const { loadConfig: loadEnabled } = await loadConfigModule();
      expect(loadEnabled().tlsVerify).toBe(true);

      setValidEnv({ FERRUM_TLS_VERIFY: undefined });
      const { loadConfig: loadDefault } = await loadConfigModule();
      expect(loadDefault().tlsVerify).toBe(true);
    });

    it('honors a custom FERRUM_JWT_ISSUER', async () => {
      setValidEnv({ FERRUM_JWT_ISSUER: 'custom-issuer' });
      const { loadConfig } = await loadConfigModule();
      expect(loadConfig().jwtIssuer).toBe('custom-issuer');
    });
  });

  describe('updateRuntimeConfig', () => {
    it('overlays overrides onto the base config', async () => {
      setValidEnv();
      const { loadConfig, updateRuntimeConfig } = await loadConfigModule();

      const before = loadConfig();
      expect(before.adminUrl).toBe('http://127.0.0.1:9000');
      expect(before.jwtTtl).toBe(3600);

      updateRuntimeConfig({
        adminUrl: 'http://override:9000',
        jwtTtl: 900,
      });

      const after = loadConfig();
      expect(after.adminUrl).toBe('http://override:9000');
      expect(after.jwtTtl).toBe(900);
      // Untouched fields keep their base value.
      expect(after.jwtSecret).toBe('unit-test-secret');
      expect(after.jwtIssuer).toBe('ferrum-edge');
    });

    it('returns a fresh object so callers cannot mutate the cached base', async () => {
      setValidEnv();
      const { loadConfig, updateRuntimeConfig } = await loadConfigModule();

      // Mutating the returned object must not leak into subsequent reads.
      const first = loadConfig();
      first.adminUrl = 'http://tampered:9000';
      first.jwtTtl = -1;

      const second = loadConfig();
      expect(second.adminUrl).toBe('http://127.0.0.1:9000');
      expect(second.jwtTtl).toBe(3600);

      // updateRuntimeConfig overlays without disturbing untouched fields.
      updateRuntimeConfig({ adminUrl: 'http://override:9000' });
      const third = loadConfig();
      expect(third.adminUrl).toBe('http://override:9000');
      expect(third.jwtSecret).toBe('unit-test-secret');
    });

    it('ignores the masked-secret sentinel when updating jwtSecret', async () => {
      setValidEnv();
      const { loadConfig, updateRuntimeConfig, MASKED_SECRET } =
        await loadConfigModule();

      const originalSecret = loadConfig().jwtSecret;
      updateRuntimeConfig({ jwtSecret: MASKED_SECRET });
      expect(loadConfig().jwtSecret).toBe(originalSecret);

      updateRuntimeConfig({ jwtSecret: 'rotated-secret' });
      expect(loadConfig().jwtSecret).toBe('rotated-secret');
    });

    it('masks jwtSecret in getRuntimeConfig output', async () => {
      setValidEnv();
      const { getRuntimeConfig, MASKED_SECRET } = await loadConfigModule();
      expect(getRuntimeConfig().jwtSecret).toBe(MASKED_SECRET);
    });
  });
});
