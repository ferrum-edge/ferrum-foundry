import type { FastifyPluginAsync } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import {
  createManifestPreview,
  MANIFEST_BODY_LIMIT,
  MANIFEST_RESPONSE_LIMIT,
  parseManifestJson,
  validatedManifest,
} from '../service-manifest.js';

const serviceManifestPlugin: FastifyPluginAsync = async (fastify) => {
  // Encapsulated parser/error handler: malformed or oversized input never
  // returns parser excerpts, validator keys/values, or logs submitted data.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', {
    parseAs: 'string', bodyLimit: MANIFEST_BODY_LIMIT,
  }, (_request, body, done) => {
    try {
      done(null, parseManifestJson(body as string));
    } catch {
      done(Object.assign(new Error('Invalid manifest JSON'), { statusCode: 400 }));
    }
  });
  fastify.setErrorHandler((error, _request, reply) => {
    const status = error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 500;
    return reply.status(status).send({
      error: status === 413
        ? 'Manifest exceeds the preview budget'
        : 'Manifest preview unavailable',
      code: 'FERRUM_BFF_MANIFEST_INPUT',
    });
  });

  fastify.post('/api/service-manifest/preview', {
    bodyLimit: MANIFEST_BODY_LIMIT,
    // Fastify logs before onRequest: even a refused query may contain secrets.
    logSerializers: {
      req: () => ({ method: 'POST', url: '/api/service-manifest/preview' }),
    },
    onRequest: async (request, reply) => {
      await requireAdminAuth(request, reply);
      if (reply.sent) return;
      const namespace = request.headers['x-ferrum-namespace'];
      const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0
        && value.toLowerCase() === 'x-ferrum-namespace').length;
      if (count !== 1 || typeof namespace !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/.test(namespace)) {
        return reply.status(400).send({ error: 'A single namespace binding is required' });
      }
      const principal = request.authPrincipal;
      if (!principal || (principal.namespaces && !principal.namespaces.includes(namespace))) {
        reply.header('x-ferrum-auth-layer', 'bff');
        return reply.status(403).send({ error: 'Namespace access denied' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        return reply.status(415).send({ error: 'Manifest preview requires JSON' });
      }
      if (request.url.includes('?')) {
        return reply.status(400).send({ error: 'Manifest preview accepts no query parameters' });
      }
    },
  }, async (request, reply) => {
    const manifest = validatedManifest(request.body);
    if (!manifest) return reply.status(400).send({
      error: 'Manifest does not match the supported v1 schema or preview normalization',
      code: 'FERRUM_BFF_MANIFEST_INVALID',
    });
    if (manifest.gateway.namespace !== request.headers['x-ferrum-namespace']) {
      reply.header('x-ferrum-auth-layer', 'bff');
      return reply.status(403).send({
        error: 'Manifest namespace must match the authorized binding',
      });
    }
    const preview = createManifestPreview(manifest);
    if (Buffer.byteLength(JSON.stringify(preview)) > MANIFEST_RESPONSE_LIMIT) {
      return reply.status(400).send({ error: 'Desired configuration exceeds the preview budget' });
    }
    return preview;
  });
};

export default serviceManifestPlugin;
