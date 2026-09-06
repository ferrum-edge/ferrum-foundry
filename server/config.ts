import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { loadCaBundle } from './ca.js';

export type GatewayRole = 'viewer' | 'operator' | 'admin';
export type AuthMode = 'static' | 'trusted-proxy';

export interface Config {
  adminUrl: string;
  initialAdminOrigin: string;
  adminAllowedOrigins: string[];
  adminAllowedCidrs: string[];
  jwtSecret: string;
  jwtIssuer: string;
  jwtTtl: number;
  jwtMaxTtl: number;
  jwtRole: GatewayRole;
  jwtAudience: string | string[] | undefined;
  jwtNamespaces: string[] | undefined;
  tlsCaPath: string | undefined;
  tlsCaRoot: string | undefined;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
  uploadTimeout: number;
  port: number;
  bindAddress: string;
  shutdownTimeout: number;
  maxLargeUploads: number;
  maxActiveUploads: number;
  allowRuntimeSettings: boolean;
  authMode: AuthMode;
  bffAuthToken: string | undefined;
  sessionTtl: number;
  trustedProxySecret: string | undefined;
  trustedProxyUserHeader: string;
  trustedProxyRoleHeader: string;
  trustedProxyNamespacesHeader: string;
  authLoginUrl: string | undefined;
  authLogoutUrl: string | undefined;
  secureCookies: boolean;
  enableHsts: boolean;
}

export interface RuntimeConfig {
  adminUrl: string;
  jwtIssuer: string;
  jwtTtl: number;
  jwtRole: GatewayRole;
  jwtAudience: string | string[] | undefined;
  jwtNamespaces: string[] | undefined;
  tlsCaPath: string | undefined;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
}

export interface PublicRuntimeConfig extends Omit<RuntimeConfig, 'tlsCaPath'> {
  authMode: AuthMode;
  tlsCaConfigured: boolean;
  runtimeSettingsEnabled: boolean;
}

const MIN_SECRET_LENGTH = 32;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

function parseInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseRole(value: string, name: string): GatewayRole {
  if (value === 'viewer' || value === 'operator' || value === 'admin') return value;
  throw new Error(`${name} must be viewer, operator, or admin`);
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  return values.length > 0 ? values : undefined;
}

function parseAudience(value: string | undefined): string | string[] | undefined {
  const values = parseList(value);
  if (!values) return undefined;
  return values.length === 1 ? values[0] : values;
}

function parseNamespaces(value: string | undefined, name: string): string[] | undefined {
  const values = parseList(value);
  if (!values) return undefined;
  for (const namespace of values) {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error(`${name} contains an invalid namespace`);
    }
  }
  return values;
}

export function normalizeAdminUrl(value: string, name = 'FERRUM_ADMIN_URL'): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin without a path, query, or fragment`);
  }
  return parsed.origin;
}

function parseOrigins(value: string | undefined): string[] {
  return (parseList(value) ?? []).map((entry) => normalizeAdminUrl(entry, 'FERRUM_ADMIN_ALLOWED_ORIGINS'));
}

function parseCidrs(value: string | undefined): string[] {
  const cidrs = parseList(value) ?? [];
  for (const cidr of cidrs) {
    const [address, rawPrefix, ...extra] = cidr.split('/');
    const family = isIP(address);
    const prefix = Number(rawPrefix);
    const maximum = family === 4 ? 32 : 128;
    if (extra.length > 0 || family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error('FERRUM_ADMIN_ALLOWED_CIDRS contains an invalid CIDR');
    }
  }
  return cidrs;
}

function parseBindAddress(value: string | undefined): string {
  const address = value ?? '0.0.0.0';
  // A literal address (or the loopback alias) keeps the listening interface an
  // explicit deployment decision instead of an implicit all-interfaces bind.
  if (address === 'localhost' || isIP(address) !== 0) return address;
  throw new Error('FERRUM_BIND_ADDRESS must be an IP address or localhost');
}

function validateSecret(value: string, name: string): string {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function validateHeaderName(value: string, name: string): string {
  const normalized = value.toLowerCase();
  if (!HEADER_NAME_PATTERN.test(normalized)) throw new Error(`${name} is not a valid HTTP header name`);
  return normalized;
}

function parseAuthRedirect(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a root-relative path or an HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${name} must be a root-relative path or an HTTPS URL`);
  }
  return parsed.toString();
}

function validateRuntimeNumber(name: string, value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function parseBaseConfig(): Config {
  const adminUrl = normalizeAdminUrl(requireEnv('FERRUM_ADMIN_URL'));
  const jwtSecret = validateSecret(requireEnv('FERRUM_JWT_SECRET'), 'FERRUM_JWT_SECRET');
  const jwtMaxTtl = parseInteger('FERRUM_JWT_MAX_TTL', 3600, 0, 86_400);
  const jwtTtl = parseInteger('FERRUM_JWT_TTL', 900, 1, 86_400);
  if (jwtMaxTtl !== 0 && jwtTtl > jwtMaxTtl) {
    throw new Error('FERRUM_JWT_TTL must not exceed FERRUM_JWT_MAX_TTL');
  }

  const authModeRaw = optionalEnv('FERRUM_AUTH_MODE') ?? 'static';
  if (authModeRaw !== 'static' && authModeRaw !== 'trusted-proxy') {
    throw new Error('FERRUM_AUTH_MODE must be static or trusted-proxy');
  }
  const authMode: AuthMode = authModeRaw;
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && authMode === 'static' && !parseBoolean('FERRUM_ALLOW_INSECURE_STATIC_AUTH', false)) {
    throw new Error(
      'Static authentication is disabled in production; configure FERRUM_AUTH_MODE=trusted-proxy',
    );
  }

  const bffAuthToken = authMode === 'static'
    ? validateSecret(requireEnv('FERRUM_BFF_AUTH_TOKEN'), 'FERRUM_BFF_AUTH_TOKEN')
    : undefined;
  const trustedProxySecret = authMode === 'trusted-proxy'
    ? validateSecret(requireEnv('FERRUM_TRUSTED_PROXY_SECRET'), 'FERRUM_TRUSTED_PROXY_SECRET')
    : undefined;

  const tlsCaPath = optionalEnv('FERRUM_TLS_CA_PATH');
  const tlsCaRoot = optionalEnv('FERRUM_TLS_CA_ROOT') ?? (tlsCaPath ? dirname(tlsCaPath) : undefined);
  if (tlsCaPath) loadCaBundle(tlsCaPath, tlsCaRoot);

  // The large-upload pool is a subset of the global in-flight upload pool, so a
  // larger large-upload cap could never be reached and would misdescribe the
  // real bound. Reject the contradiction at load instead of silently clamping.
  const maxActiveUploads = parseInteger('FERRUM_MAX_ACTIVE_UPLOADS', 32, 1, 1024);
  const maxLargeUploads = parseInteger('FERRUM_MAX_LARGE_UPLOADS', 2, 1, 32);
  if (maxLargeUploads > maxActiveUploads) {
    throw new Error('FERRUM_MAX_LARGE_UPLOADS must not exceed FERRUM_MAX_ACTIVE_UPLOADS');
  }

  const allowRuntimeSettings = parseBoolean('FERRUM_ALLOW_RUNTIME_SETTINGS', false);
  const adminAllowedOrigins = parseOrigins(optionalEnv('FERRUM_ADMIN_ALLOWED_ORIGINS'));
  if (allowRuntimeSettings && adminAllowedOrigins.length === 0) {
    throw new Error('FERRUM_ADMIN_ALLOWED_ORIGINS is required when runtime settings are enabled');
  }

  return {
    adminUrl,
    initialAdminOrigin: adminUrl,
    adminAllowedOrigins,
    adminAllowedCidrs: parseCidrs(optionalEnv('FERRUM_ADMIN_ALLOWED_CIDRS')),
    jwtSecret,
    jwtIssuer: optionalEnv('FERRUM_JWT_ISSUER') ?? 'ferrum-edge',
    jwtTtl,
    jwtMaxTtl,
    jwtRole: parseRole(optionalEnv('FERRUM_JWT_ROLE') ?? 'admin', 'FERRUM_JWT_ROLE'),
    jwtAudience: parseAudience(optionalEnv('FERRUM_JWT_AUDIENCE')),
    jwtNamespaces: parseNamespaces(optionalEnv('FERRUM_JWT_NAMESPACES'), 'FERRUM_JWT_NAMESPACES'),
    tlsCaPath,
    tlsCaRoot,
    tlsVerify: parseBoolean('FERRUM_TLS_VERIFY', true),
    connectTimeout: parseInteger('FERRUM_CONNECT_TIMEOUT', 5000, 100, 300_000),
    readTimeout: parseInteger('FERRUM_READ_TIMEOUT', 60_000, 100, 3_600_000),
    writeTimeout: parseInteger('FERRUM_WRITE_TIMEOUT', 60_000, 100, 3_600_000),
    uploadTimeout: parseInteger('FERRUM_UPLOAD_TIMEOUT', 300_000, 1000, 3_600_000),
    port: parseInteger('PORT', 3001, 1, 65_535),
    bindAddress: parseBindAddress(optionalEnv('FERRUM_BIND_ADDRESS')),
    shutdownTimeout: parseInteger('FERRUM_SHUTDOWN_TIMEOUT', 10_000, 1000, 300_000),
    maxLargeUploads,
    maxActiveUploads,
    allowRuntimeSettings,
    authMode,
    bffAuthToken,
    sessionTtl: parseInteger('FERRUM_SESSION_TTL', 3600, 60, 86_400),
    trustedProxySecret,
    trustedProxyUserHeader: validateHeaderName(
      optionalEnv('FERRUM_TRUSTED_PROXY_USER_HEADER') ?? 'x-forwarded-user',
      'FERRUM_TRUSTED_PROXY_USER_HEADER',
    ),
    trustedProxyRoleHeader: validateHeaderName(
      optionalEnv('FERRUM_TRUSTED_PROXY_ROLE_HEADER') ?? 'x-ferrum-role',
      'FERRUM_TRUSTED_PROXY_ROLE_HEADER',
    ),
    trustedProxyNamespacesHeader: validateHeaderName(
      optionalEnv('FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER') ?? 'x-ferrum-namespaces',
      'FERRUM_TRUSTED_PROXY_NAMESPACES_HEADER',
    ),
    authLoginUrl: parseAuthRedirect(optionalEnv('FERRUM_AUTH_LOGIN_URL'), 'FERRUM_AUTH_LOGIN_URL'),
    authLogoutUrl: parseAuthRedirect(optionalEnv('FERRUM_AUTH_LOGOUT_URL'), 'FERRUM_AUTH_LOGOUT_URL'),
    secureCookies: parseBoolean('FERRUM_SECURE_COOKIES', isProduction),
    enableHsts: parseBoolean('FERRUM_ENABLE_HSTS', false),
  };
}

const runtimeOverrides: Partial<RuntimeConfig> = {};
const runtimeListeners = new Set<() => void | Promise<void>>();
let baseConfig: Config | undefined;

export function loadConfig(): Config {
  if (!baseConfig) baseConfig = parseBaseConfig();
  const config = { ...baseConfig, ...runtimeOverrides };
  return {
    ...config,
    adminAllowedOrigins: [...config.adminAllowedOrigins],
    adminAllowedCidrs: [...config.adminAllowedCidrs],
    jwtAudience: Array.isArray(config.jwtAudience) ? [...config.jwtAudience] : config.jwtAudience,
    jwtNamespaces: config.jwtNamespaces ? [...config.jwtNamespaces] : undefined,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const cfg = loadConfig();
  return {
    adminUrl: cfg.adminUrl,
    jwtIssuer: cfg.jwtIssuer,
    jwtTtl: cfg.jwtTtl,
    jwtRole: cfg.jwtRole,
    jwtAudience: Array.isArray(cfg.jwtAudience) ? [...cfg.jwtAudience] : cfg.jwtAudience,
    jwtNamespaces: cfg.jwtNamespaces ? [...cfg.jwtNamespaces] : undefined,
    tlsCaPath: cfg.tlsCaPath,
    tlsVerify: cfg.tlsVerify,
    connectTimeout: cfg.connectTimeout,
    readTimeout: cfg.readTimeout,
    writeTimeout: cfg.writeTimeout,
  };
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  const { tlsCaPath, ...runtime } = getRuntimeConfig();
  return {
    ...runtime,
    authMode: loadConfig().authMode,
    tlsCaConfigured: Boolean(tlsCaPath),
    runtimeSettingsEnabled: loadConfig().allowRuntimeSettings,
  };
}

export function registerRuntimeConfigListener(listener: () => void | Promise<void>): () => void {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

export async function updateRuntimeConfig(updates: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  const current = loadConfig();
  if (!current.allowRuntimeSettings) throw new Error('Runtime settings are disabled');
  const nextOverrides: Partial<RuntimeConfig> = { ...runtimeOverrides };

  if (updates.adminUrl !== undefined) {
    if (typeof updates.adminUrl !== 'string') throw new Error('adminUrl must be a string');
    const normalized = normalizeAdminUrl(updates.adminUrl, 'adminUrl');
    const allowed = new Set([current.initialAdminOrigin, ...current.adminAllowedOrigins]);
    if (!allowed.has(normalized)) throw new Error('adminUrl is not in FERRUM_ADMIN_ALLOWED_ORIGINS');
    nextOverrides.adminUrl = normalized;
  }
  if (updates.jwtIssuer !== undefined) {
    if (typeof updates.jwtIssuer !== 'string' || !updates.jwtIssuer.trim()) {
      throw new Error('jwtIssuer must be a non-empty string');
    }
    nextOverrides.jwtIssuer = updates.jwtIssuer.trim();
  }
  if (updates.jwtTtl !== undefined) {
    const ttl = validateRuntimeNumber('jwtTtl', updates.jwtTtl, 1, 86_400);
    if (current.jwtMaxTtl !== 0 && ttl > current.jwtMaxTtl) {
      throw new Error('jwtTtl exceeds the configured gateway maximum');
    }
    nextOverrides.jwtTtl = ttl;
  }
  if (updates.jwtRole !== undefined) nextOverrides.jwtRole = parseRole(updates.jwtRole, 'jwtRole');
  if (updates.jwtAudience !== undefined) {
    if (typeof updates.jwtAudience !== 'string' && !Array.isArray(updates.jwtAudience)) {
      throw new Error('jwtAudience must be a string or string array');
    }
    if (Array.isArray(updates.jwtAudience) && updates.jwtAudience.some((value) => typeof value !== 'string')) {
      throw new Error('jwtAudience must contain only strings');
    }
    const raw = Array.isArray(updates.jwtAudience)
      ? updates.jwtAudience.join(',')
      : updates.jwtAudience;
    nextOverrides.jwtAudience = parseAudience(raw);
  }
  if (updates.jwtNamespaces !== undefined) {
    if (!Array.isArray(updates.jwtNamespaces) || updates.jwtNamespaces.some((value) => typeof value !== 'string')) {
      throw new Error('jwtNamespaces must be a string array');
    }
    nextOverrides.jwtNamespaces = parseNamespaces(updates.jwtNamespaces.join(','), 'jwtNamespaces');
  }
  if (updates.tlsCaPath !== undefined) {
    if (typeof updates.tlsCaPath !== 'string') throw new Error('tlsCaPath must be a string');
    if (!current.tlsCaRoot) throw new Error('FERRUM_TLS_CA_ROOT is required for runtime CA changes');
    nextOverrides.tlsCaPath = loadCaBundle(updates.tlsCaPath, current.tlsCaRoot).path;
  }
  if (updates.tlsVerify !== undefined) {
    if (typeof updates.tlsVerify !== 'boolean') throw new Error('tlsVerify must be a boolean');
    nextOverrides.tlsVerify = updates.tlsVerify;
  }
  if (updates.connectTimeout !== undefined) {
    nextOverrides.connectTimeout = validateRuntimeNumber('connectTimeout', updates.connectTimeout, 100, 300_000);
  }
  if (updates.readTimeout !== undefined) {
    nextOverrides.readTimeout = validateRuntimeNumber('readTimeout', updates.readTimeout, 100, 3_600_000);
  }
  if (updates.writeTimeout !== undefined) {
    nextOverrides.writeTimeout = validateRuntimeNumber('writeTimeout', updates.writeTimeout, 100, 3_600_000);
  }

  Object.assign(runtimeOverrides, nextOverrides);
  await Promise.all([...runtimeListeners].map((listener) => listener()));
  return getRuntimeConfig();
}
