import type { FastifyPluginAsync } from 'fastify';
import { getRuntimeConfig, updateRuntimeConfig, loadConfig } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { fetch, Agent } from 'undici';
import { generateToken } from '../jwt.js';

const settingsPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /api/settings - return current runtime config (never expose JWT secret)
  fastify.get('/api/settings', async () => {
    return getRuntimeConfig();
  });

  // PUT /api/settings - update runtime config
  fastify.put('/api/settings', async (request, reply) => {
    const body = request.body as Partial<RuntimeConfig>;

    // Basic validation
    if (body.adminUrl !== undefined && typeof body.adminUrl !== 'string') {
      return reply.status(400).send({ error: 'adminUrl must be a string' });
    }
    if (body.tlsVerify !== undefined && typeof body.tlsVerify !== 'boolean') {
      return reply.status(400).send({ error: 'tlsVerify must be a boolean' });
    }
    if (body.connectTimeout !== undefined && (typeof body.connectTimeout !== 'number' || body.connectTimeout <= 0)) {
      return reply.status(400).send({ error: 'connectTimeout must be a positive number' });
    }
    if (body.readTimeout !== undefined && (typeof body.readTimeout !== 'number' || body.readTimeout <= 0)) {
      return reply.status(400).send({ error: 'readTimeout must be a positive number' });
    }
    if (body.writeTimeout !== undefined && (typeof body.writeTimeout !== 'number' || body.writeTimeout <= 0)) {
      return reply.status(400).send({ error: 'writeTimeout must be a positive number' });
    }

    const updated = updateRuntimeConfig(body);
    return updated;
  });

  // GET /api/settings/status - test connectivity to admin API
  fastify.get('/api/settings/status', async (_request, reply) => {
    const config = loadConfig();
    const token = await generateToken(config);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.readTimeout);

    try {
      const isHttps = config.adminUrl.startsWith('https://');
      const dispatcher = new Agent({
        connect: {
          timeout: config.connectTimeout,
          ...(isHttps && {
            rejectUnauthorized: config.tlsVerify,
            ...(config.tlsCaPath && {
              ca: (await import('node:fs')).readFileSync(config.tlsCaPath, 'utf-8'),
            }),
          }),
        },
      });

      const response = await fetch(`${config.adminUrl}/health`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
        dispatcher,
      });

      clearTimeout(timeoutId);

      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }

      return reply.status(response.status).send({
        reachable: response.ok,
        status: response.status,
        body: parsed,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({
        reachable: false,
        error: message,
      });
    }
  });
};

export default settingsPlugin;
