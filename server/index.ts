import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import proxyPlugin from './proxy.js';
import settingsPlugin from './routes/settings.js';
import healthPlugin from './routes/health.js';

const config = loadConfig();
const isProduction = process.env.NODE_ENV === 'production';

const fastify = Fastify({
  logger: {
    level: isProduction ? 'info' : 'debug',
  },
  // Restore payloads can carry a full gateway backup (gateway default cap
  // is 100 MiB); leave headroom for JSON envelope overhead.
  bodyLimit: 110 * 1024 * 1024,
});

// CORS - allow all origins in dev
await fastify.register(cors, {
  origin: isProduction ? false : true,
});

// Accept raw YAML/text bodies (API spec uploads) as plain strings so the
// admin proxy can forward them verbatim to the gateway.
for (const contentType of [
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
  'text/plain',
]) {
  fastify.addContentTypeParser(
    contentType,
    { parseAs: 'string', bodyLimit: 30 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
}

// API routes
await fastify.register(healthPlugin);
await fastify.register(settingsPlugin);
await fastify.register(proxyPlugin);

// In production, serve the built SPA
if (isProduction) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distPath = join(__dirname, '..', 'dist');

  const fastifyStatic = (await import('@fastify/static')).default;
  await fastify.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });
}

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, shutting down gracefully`);
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
