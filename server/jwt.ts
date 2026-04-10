import { SignJWT } from 'jose';
import type { Config } from './config.js';

let cachedToken: string | undefined;
let tokenExp: number | undefined;

export async function generateToken(config: Config): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && tokenExp && now < tokenExp - 60) {
    return cachedToken;
  }

  const secret = new TextEncoder().encode(config.jwtSecret);
  const exp = now + config.jwtTtl;

  cachedToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.jwtIssuer)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);

  tokenExp = exp;
  return cachedToken;
}
