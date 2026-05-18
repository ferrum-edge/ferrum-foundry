import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';

export function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): void {
  const config = loadConfig();
  const authorization = request.headers.authorization;

  if (!authorization || !authorization.startsWith('Bearer ')) {
    void reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token || token !== config.bffAuthToken) {
    void reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
}
