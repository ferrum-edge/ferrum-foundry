import type { FastifyPluginAsync } from 'fastify';

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/health', async () => {
    return { status: 'ok', version: '0.1.0' };
  });
};

export default healthPlugin;
