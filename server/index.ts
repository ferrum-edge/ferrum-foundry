import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createShutdownHandler } from './shutdown.js';

const config = loadConfig();
const fastify = await buildApp();

const shutdown = createShutdownHandler({
  close: () => fastify.close(),
  log: {
    info: (payload, message) => fastify.log.info(payload, message),
    error: (payload, message) => fastify.log.error(payload, message),
  },
  timeoutMs: config.shutdownTimeout,
  exit: (code) => process.exit(code),
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await fastify.listen({ port: config.port, host: config.bindAddress });
  fastify.log.info({ host: config.bindAddress, port: config.port }, 'Server listening');
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
