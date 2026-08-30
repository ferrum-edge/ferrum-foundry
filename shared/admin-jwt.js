import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const MIN_SECRET_LENGTH = 32;
const MAX_TTL_SECONDS = 86_400;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;
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

function normalizeNamespaces(namespaces) {
  if (namespaces === undefined) return undefined;
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new Error('namespaces must be a non-empty array when provided');
  }
  const values = [...new Set(namespaces.map((entry) => requireNonEmpty(entry, 'namespace').trim()))];
  if (values.some((entry) => !NAMESPACE_PATTERN.test(entry))) {
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
  ttlSeconds,
  now = Math.floor(Date.now() / 1000),
  jti = randomUUID(),
}) {
  requireNonEmpty(secret, 'secret');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`secret must be at least ${MIN_SECRET_LENGTH} characters`);
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

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(jti);

  if (normalizedAudience) signer = signer.setAudience(normalizedAudience);
  return signer.sign(new TextEncoder().encode(secret));
}
