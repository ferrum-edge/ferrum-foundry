import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';

const BEARER_PREFIX = /^Bearer\s+/i;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still run a fixed-length compare to avoid leaking via early-return timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export async function requireAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const config = loadConfig();
  const authorization = request.headers.authorization;

  if (!authorization || !BEARER_PREFIX.test(authorization)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const token = authorization.replace(BEARER_PREFIX, '').trim();
  if (!token || !safeEqual(token, config.bffAuthToken)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
