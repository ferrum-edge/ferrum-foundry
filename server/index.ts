import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const fastify = await buildApp();

const shutdown = async (signal: string) => {
  fastify.log.info({ signal }, 'Shutting down gracefully');
  await fastify.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  fastify.log.info({ port: config.port }, 'Server listening');
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
