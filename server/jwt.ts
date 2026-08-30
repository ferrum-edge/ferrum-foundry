import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AuthPrincipal } from './auth-types.js';
import type { Config } from './config.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 256;
const tokenCache = new Map<string, CachedToken>();

function tokenFingerprint(config: Config, principal: AuthPrincipal): string {
  return createHash('sha256')
    .update(config.jwtSecret)
    .update('\0')
    .update(JSON.stringify({
      issuer: config.jwtIssuer,
      ttl: config.jwtTtl,
      audience: config.jwtAudience,
      subject: principal.subject,
      role: principal.role,
      namespaces: principal.namespaces,
    }))
    .digest('hex');
}

function pruneCache(now: number): void {
  for (const [key, value] of tokenCache) {
    if (value.expiresAt <= now) tokenCache.delete(key);
  }
  while (tokenCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value as string | undefined;
    if (!oldest) break;
    tokenCache.delete(oldest);
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export async function generateToken(config: Config, principal: AuthPrincipal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fingerprint = tokenFingerprint(config, principal);
  const cached = tokenCache.get(fingerprint);
  const refreshBuffer = Math.min(60, Math.max(1, Math.floor(config.jwtTtl / 4)));
  if (cached && now < cached.expiresAt - refreshBuffer) {
    // Refresh insertion order so active users stay in the bounded LRU cache.
    tokenCache.delete(fingerprint);
    tokenCache.set(fingerprint, cached);
    return cached.token;
  }

  pruneCache(now);
  const expiresAt = now + config.jwtTtl;
  const namespaces = principal.namespaces;
  const claims: Record<string, unknown> = { role: principal.role };
  if (namespaces) claims.ns = namespaces.length === 1 ? namespaces[0] : namespaces;

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.jwtIssuer)
    .setSubject(principal.subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID());

  if (config.jwtAudience) signer = signer.setAudience(config.jwtAudience);

  const token = await signer.sign(new TextEncoder().encode(config.jwtSecret));
  tokenCache.set(fingerprint, { token, expiresAt });
  return token;
}
