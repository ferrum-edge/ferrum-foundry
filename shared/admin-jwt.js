import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { isNamespaceName } from './namespace.js';

const MIN_SECRET_LENGTH = 32;
const MAX_TTL_SECONDS = 86_400;
const ROLES = new Set(['viewer', 'operator', 'admin']);

function requireNonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeAudience(audience) {
  if (audience === undefined) return undefined;
  const values = (Array.isArray(audience) ? audience : [audience])
    .map((entry) => requireNonEmpty(entry, 'audience').trim());
  if (values.length === 0) throw new Error('audience must not be empty');
  return values.length === 1 ? values[0] : values;
}

// RFC 6749 section 3.3 scope-token: printable ASCII except space, `"` and `\`.
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function normalizeScopes(scopes) {
  if (scopes === undefined) return undefined;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array when provided');
  }
  const values = [...new Set(scopes)];
  if (values.some((entry) => typeof entry !== 'string' || !SCOPE_TOKEN_PATTERN.test(entry))) {
    throw new Error('scopes contains an invalid scope token');
  }
  return values;
}

function normalizeNamespaces(namespaces) {
  if (namespaces === undefined) return undefined;
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new Error('namespaces must be a non-empty array when provided');
  }
  const values = [...new Set(namespaces.map((entry) => requireNonEmpty(entry, 'namespace').trim()))];
  if (values.some((entry) => !isNamespaceName(entry))) {
    throw new Error('namespaces contains an invalid namespace');
  }
  return values;
}

/**
 * Sign a Ferrum Edge Admin API JWT using the one claim contract shared by the
 * BFF and operational scripts. Callers remain responsible for authorizing the
 * subject, role, and namespace inputs before invoking this function.
 */
export async function signAdminJwt({
  secret,
  issuer,
  subject,
  role,
  audience,
  namespaces,
  scopes,
  ttlSeconds,
  now = Math.floor(Date.now() / 1000),
  jti = randomUUID(),
}) {
  requireNonEmpty(secret, 'secret');
  // The key is used verbatim, and measured in UTF-8 bytes, as Ferrum Edge does.
  const key = new TextEncoder().encode(secret);
  if (key.length < MIN_SECRET_LENGTH) {
    throw new Error(`secret must be at least ${MIN_SECRET_LENGTH} bytes`);
  }
  requireNonEmpty(issuer, 'issuer');
  requireNonEmpty(subject, 'subject');
  if (!ROLES.has(role)) throw new Error('role must be viewer, operator, or admin');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`);
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative integer');
  requireNonEmpty(jti, 'jti');

  const normalizedAudience = normalizeAudience(audience);
  const normalizedNamespaces = normalizeNamespaces(namespaces);
  const claims = { role };
  if (normalizedNamespaces) {
    claims.ns = normalizedNamespaces.length === 1 ? normalizedNamespaces[0] : normalizedNamespaces;
  }
  // An OAuth 2.0 space-delimited `scope`. Only a caller that has authorized
  // the scope passes it: no role implies one (Edge's diagnostics lookup).
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes) claims.scope = normalizedScopes.join(' ');

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(jti);

  if (normalizedAudience) signer = signer.setAudience(normalizedAudience);
  return signer.sign(key);
}
