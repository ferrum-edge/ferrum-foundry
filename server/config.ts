import { readFileSync } from 'node:fs';

export interface Config {
  adminUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtTtl: number;
  tlsCaPath: string | undefined;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
  port: number;
}

export interface RuntimeConfig {
  adminUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtTtl: number;
  tlsCaPath: string | undefined;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function parseBaseConfig(): Config {
  const tlsCaPath = process.env.FERRUM_TLS_CA_PATH;
  if (tlsCaPath) {
    // Validate the file is readable at startup
    readFileSync(tlsCaPath);
  }

  return {
    adminUrl: requireEnv('FERRUM_ADMIN_URL'),
    jwtSecret: requireEnv('FERRUM_JWT_SECRET'),
    jwtIssuer: process.env.FERRUM_JWT_ISSUER ?? 'ferrum-edge',
    jwtTtl: Number(process.env.FERRUM_JWT_TTL ?? 3600),
    tlsCaPath,
    tlsVerify: process.env.FERRUM_TLS_VERIFY !== 'false',
    connectTimeout: Number(process.env.FERRUM_CONNECT_TIMEOUT ?? 5000),
    readTimeout: Number(process.env.FERRUM_READ_TIMEOUT ?? 60000),
    writeTimeout: Number(process.env.FERRUM_WRITE_TIMEOUT ?? 60000),
    port: Number(process.env.PORT ?? 3001),
  };
}

// In-memory runtime overrides
let runtimeOverrides: Partial<RuntimeConfig> = {};
let baseConfig: Config | undefined;

export function loadConfig(): Config {
  if (!baseConfig) {
    baseConfig = parseBaseConfig();
  }
  return { ...baseConfig, ...runtimeOverrides };
}

export function getRuntimeConfig(): RuntimeConfig {
  const cfg = loadConfig();
  return {
    adminUrl: cfg.adminUrl,
    jwtSecret: cfg.jwtSecret,
    jwtIssuer: cfg.jwtIssuer,
    jwtTtl: cfg.jwtTtl,
    tlsCaPath: cfg.tlsCaPath,
    tlsVerify: cfg.tlsVerify,
    connectTimeout: cfg.connectTimeout,
    readTimeout: cfg.readTimeout,
    writeTimeout: cfg.writeTimeout,
  };
}

export function updateRuntimeConfig(updates: Partial<RuntimeConfig>): RuntimeConfig {
  if (updates.adminUrl !== undefined) runtimeOverrides.adminUrl = updates.adminUrl;
  if (updates.jwtSecret !== undefined) runtimeOverrides.jwtSecret = updates.jwtSecret;
  if (updates.jwtIssuer !== undefined) runtimeOverrides.jwtIssuer = updates.jwtIssuer;
  if (updates.jwtTtl !== undefined) runtimeOverrides.jwtTtl = updates.jwtTtl;
  if (updates.tlsCaPath !== undefined) runtimeOverrides.tlsCaPath = updates.tlsCaPath;
  if (updates.tlsVerify !== undefined) runtimeOverrides.tlsVerify = updates.tlsVerify;
  if (updates.connectTimeout !== undefined) runtimeOverrides.connectTimeout = updates.connectTimeout;
  if (updates.readTimeout !== undefined) runtimeOverrides.readTimeout = updates.readTimeout;
  if (updates.writeTimeout !== undefined) runtimeOverrides.writeTimeout = updates.writeTimeout;

  return getRuntimeConfig();
}
