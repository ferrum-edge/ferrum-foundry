import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPrincipal } from './auth-types.js';
import { loadConfig, type Config, type GatewayRole } from './config.js';
import { proxyPathIsFleetGlobal, requestIsProxyRoute } from './proxy-path.js';

interface StaticSession {
  principal: AuthPrincipal;
  csrfToken: string;
  expiresAt: number;
}

const MAX_STATIC_SESSIONS = 256;
const staticSessions = new Map<string, StaticSession>();
const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;
const TRUSTED_PROXY_SECRET_HEADER = 'x-ferrum-auth-secret';
// Domain-separated key derivation so the CSRF MAC can never be confused with
// any other use of the trusted-proxy proof secret.
const CSRF_KEY_LABEL = 'ferrum-foundry-csrf-v1';
const CSRF_MAC_CONTEXT = 'csrf';
// Reissue once a token is inside its final quarter so an open tab refreshes
// before the cookie it already holds expires.
const CSRF_REISSUE_FRACTION = 0.25;
const CSRF_EXPIRY_PATTERN = /^\d{1,15}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return undefined;
  return value?.trim() || undefined;
}

function cookieNames(config: Config): { session: string; csrf: string } {
  return config.secureCookies
    ? { session: '__Host-ferrum-foundry-session', csrf: '__Host-ferrum-foundry-csrf' }
    : { session: 'ferrum-foundry-session', csrf: 'ferrum-foundry-csrf' };
}

function cookieOptions(config: Config, httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    secure: config.secureCookies,
    sameSite: 'strict' as const,
    maxAge: config.sessionTtl,
  };
}

function pruneSessions(now = Date.now()): void {
  for (const [id, session] of staticSessions) {
    if (session.expiresAt <= now) staticSessions.delete(id);
  }
  while (staticSessions.size >= MAX_STATIC_SESSIONS) {
    const oldest = staticSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    staticSessions.delete(oldest);
  }
}

let csrfKeyCache: { secret: string; key: Buffer } | undefined;

function csrfKey(secret: string): Buffer {
  if (!csrfKeyCache || csrfKeyCache.secret !== secret) {
    csrfKeyCache = { secret, key: createHmac('sha256', secret).update(CSRF_KEY_LABEL).digest() };
  }
  return csrfKeyCache.key;
}

function csrfMac(secret: string, subject: string, expiresAtSeconds: number): string {
  return createHmac('sha256', csrfKey(secret))
    .update(`${CSRF_MAC_CONTEXT}\0${subject}\0${expiresAtSeconds}`)
    .digest('base64url');
}

// Trusted-proxy CSRF tokens are signed double-submit values rather than rows in
// a per-process map: the identity proxy already authenticated the request, so
// any replica holding the same secret can verify the token without shared state.
function issueTrustedCsrfToken(config: Config, subject: string): string | undefined {
  if (!config.trustedProxySecret) return undefined;
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + config.sessionTtl;
  const encodedExpiry = Buffer.from(String(expiresAtSeconds), 'utf8').toString('base64url');
  return `${encodedExpiry}.${csrfMac(config.trustedProxySecret, subject, expiresAtSeconds)}`;
}

/** Returns the token's expiry in milliseconds, or undefined when it is not valid. */
function readTrustedCsrfExpiry(config: Config, subject: string, token: string): number | undefined {
  if (!config.trustedProxySecret) return undefined;
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [encodedExpiry, mac] = parts;
  const decodedExpiry = Buffer.from(encodedExpiry, 'base64url').toString('utf8');
  if (!CSRF_EXPIRY_PATTERN.test(decodedExpiry)) return undefined;
  const expiresAtSeconds = Number(decodedExpiry);
  if (!Number.isSafeInteger(expiresAtSeconds)) return undefined;
  const expiresAt = expiresAtSeconds * 1000;
  if (expiresAt <= Date.now()) return undefined;
  if (!safeEqual(mac, csrfMac(config.trustedProxySecret, subject, expiresAtSeconds))) return undefined;
  return expiresAt;
}

function staticPrincipal(config: Config): AuthPrincipal {
  return {
    subject: 'ferrum-foundry-static',
    displayName: 'Local administrator',
    role: config.jwtRole,
    namespaces: config.jwtNamespaces,
    authMode: 'static',
  };
}

function parseRole(value: string | undefined): GatewayRole | undefined {
  return value === 'viewer' || value === 'operator' || value === 'admin' ? value : undefined;
}

function parseTrustedNamespaces(value: string | undefined): string[] | undefined | null {
  if (value === undefined) return undefined;
  const namespaces = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  if (namespaces.length === 0 || namespaces.some((namespace) => !NAMESPACE_PATTERN.test(namespace))) {
    return null;
  }
  return namespaces;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function trustedProxyPrincipal(request: FastifyRequest, config: Config): AuthPrincipal | undefined {
  const suppliedSecret = singleHeader(request, TRUSTED_PROXY_SECRET_HEADER);
  if (!suppliedSecret || !config.trustedProxySecret || !safeEqual(suppliedSecret, config.trustedProxySecret)) {
    return undefined;
  }

  const subject = singleHeader(request, config.trustedProxyUserHeader);
  const role = parseRole(singleHeader(request, config.trustedProxyRoleHeader));
  const namespaces = parseTrustedNamespaces(singleHeader(request, config.trustedProxyNamespacesHeader));
  if (!subject || subject.length > 254 || containsControlCharacter(subject) || !role || namespaces === null) {
    return undefined;
  }
  // Non-admin identities must receive explicit namespace grants. Admins may
  // intentionally be global by omitting the namespace header.
  if (role !== 'admin' && namespaces === undefined) return undefined;

  return {
    subject,
    displayName: subject,
    role,
    namespaces,
    authMode: 'trusted-proxy',
  };
}

function readStaticSession(request: FastifyRequest, config: Config): StaticSession | undefined {
  const id = request.cookies[cookieNames(config).session];
  if (!id) return undefined;
  const session = staticSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) staticSessions.delete(id);
    return undefined;
  }
  staticSessions.delete(id);
  staticSessions.set(id, session);
  return session;
}

function csrfIsValid(
  request: FastifyRequest,
  config: Config,
  principal: AuthPrincipal,
  session?: StaticSession,
): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  const names = cookieNames(config);
  const cookieToken = request.cookies[names.csrf];
  const headerToken = singleHeader(request, 'x-csrf-token');
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) return false;
  if (session) return safeEqual(session.csrfToken, headerToken);
  return readTrustedCsrfExpiry(config, principal.subject, headerToken) !== undefined;
}

function namespaceIsAllowed(request: FastifyRequest, principal: AuthPrincipal): boolean {
  if (!principal.namespaces) return true;
  if (!requestIsProxyRoute(request)) return true;
  // Ferrum documents TLS management as a fleet-global surface. The namespace
  // header is inert there, so Foundry must not pretend that it scopes access.
  if (proxyPathIsFleetGlobal(request)) return true;
  const namespace = singleHeader(request, 'x-ferrum-namespace');
  return Boolean(namespace && principal.namespaces.includes(namespace));
}

function rejectAuth(reply: FastifyReply, status = 401, error = 'Unauthorized'): FastifyReply {
  reply.header('x-ferrum-auth-layer', 'bff');
  return reply.status(status).send({ error });
}

export async function resolvePrincipal(request: FastifyRequest): Promise<AuthPrincipal | undefined> {
  const config = loadConfig();
  if (config.authMode === 'trusted-proxy') return trustedProxyPrincipal(request, config);
  return readStaticSession(request, config)?.principal;
}

export async function requireAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const config = loadConfig();
  const session = config.authMode === 'static' ? readStaticSession(request, config) : undefined;
  const principal = session?.principal ?? trustedProxyPrincipal(request, config);
  if (!principal) return rejectAuth(reply);
  if (!csrfIsValid(request, config, principal, session)) return rejectAuth(reply, 403, 'CSRF validation failed');
  if (!namespaceIsAllowed(request, principal)) return rejectAuth(reply, 403, 'Namespace access denied');
  request.authPrincipal = principal;
}

export function requireRole(required: GatewayRole) {
  const order: Record<GatewayRole, number> = { viewer: 0, operator: 1, admin: 2 };
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    await requireAdminAuth(request, reply);
    if (reply.sent) return;
    if (!request.authPrincipal || order[request.authPrincipal.role] < order[required]) {
      return rejectAuth(reply, 403, 'Insufficient role');
    }
  };
}

function issueCsrfCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(cookieNames(config).csrf, token, cookieOptions(config, false));
}

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/auth/config', async () => {
    const config = loadConfig();
    return {
      mode: config.authMode,
      loginUrl: config.authLoginUrl,
      logoutUrl: config.authLogoutUrl,
    };
  });

  fastify.post('/api/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const config = loadConfig();
    if (config.authMode !== 'static') return reply.status(404).send({ error: 'Not Found' });
    const body = request.body as { token?: unknown } | undefined;
    if (typeof body?.token !== 'string' || !config.bffAuthToken || !safeEqual(body.token, config.bffAuthToken)) {
      return rejectAuth(reply);
    }

    pruneSessions();
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session: StaticSession = {
      principal: staticPrincipal(config),
      csrfToken,
      expiresAt: Date.now() + config.sessionTtl * 1000,
    };
    staticSessions.set(sessionId, session);
    reply.setCookie(cookieNames(config).session, sessionId, cookieOptions(config, true));
    issueCsrfCookie(reply, config, csrfToken);
    return { principal: session.principal, csrfToken, expiresAt: session.expiresAt };
  });

  fastify.get('/api/auth/session', async (request, reply) => {
    const config = loadConfig();
    const session = config.authMode === 'static' ? readStaticSession(request, config) : undefined;
    const principal = session?.principal ?? trustedProxyPrincipal(request, config);
    if (!principal) return rejectAuth(reply);

    let csrfToken = session?.csrfToken;
    if (!session) {
      // Keep a still-fresh cookie stable so concurrent tabs do not invalidate
      // each other's in-flight token, but reissue before it can expire.
      const cookieToken = request.cookies[cookieNames(config).csrf];
      const expiresAt = cookieToken
        ? readTrustedCsrfExpiry(config, principal.subject, cookieToken)
        : undefined;
      const reusable = expiresAt !== undefined
        && expiresAt - Date.now() > config.sessionTtl * 1000 * CSRF_REISSUE_FRACTION;
      csrfToken = reusable ? cookieToken : issueTrustedCsrfToken(config, principal.subject);
    }
    if (!csrfToken) return rejectAuth(reply);
    issueCsrfCookie(reply, config, csrfToken);
    return {
      principal,
      csrfToken,
      expiresAt: session?.expiresAt,
      logoutUrl: config.authLogoutUrl,
    };
  });

  fastify.post('/api/auth/logout', { onRequest: requireAdminAuth }, async (request, reply) => {
    const config = loadConfig();
    const names = cookieNames(config);
    const sessionId = request.cookies[names.session];
    if (sessionId) staticSessions.delete(sessionId);
    // Trusted-proxy CSRF tokens hold no server-side state; clearing the cookie
    // is the whole revocation, and the identity proxy owns the user session.
    reply.clearCookie(names.session, { path: '/', secure: config.secureCookies });
    reply.clearCookie(names.csrf, { path: '/', secure: config.secureCookies });
    return { loggedOut: true, logoutUrl: config.authLogoutUrl };
  });
};
