import type { FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import {
  createManifestPreview,
  MANIFEST_BODY_LIMIT,
  MANIFEST_RESPONSE_LIMIT,
  parseManifestJson,
  validatedManifest,
} from '../service-manifest.js';

const PREVIEW_PATH = '/api/service-manifest/preview';

function isManifestRequest(url: string | undefined): boolean {
  const path = (url ?? '').split('?', 1)[0].replace(/^https?:\/\/[^/]+/, '');
  // The router decodes static ASCII path segments too. Decode just ASCII
  // escapes, so a malformed suffix cannot defeat prefix recognition or throw.
  const decoded = path.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return decoded.startsWith('/api/service-manifest/');
}

function httpStatusCode(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || !('statusCode' in value)) return null;
  const status = value.statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function manifestInputFailure(error: unknown): {
  status: 400 | 413 | 500;
  body: { error: string; code: 'FERRUM_BFF_MANIFEST_INPUT' };
} {
  const candidate = httpStatusCode(error);
  const status = candidate === 413 ? 413 : candidate === 400 ? 400 : 500;
  return {
    status,
    body: {
      error: status === 413
        ? 'Manifest exceeds the preview budget'
        : 'Manifest preview unavailable',
      code: 'FERRUM_BFF_MANIFEST_INPUT',
    },
  };
}

// Install at construction, not in a hook or the route's plugin context:
// malformed URLs can bypass routing, and incoming logs precede onRequest/auth.
export const serviceManifestRequestLogging: Pick<
  FastifyServerOptions,
  'childLoggerFactory' | 'frameworkErrors'
> = {
  childLoggerFactory(logger, bindings, options, rawRequest) {
    if (!isManifestRequest(rawRequest.url)) return logger.child(bindings, options);
    return logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: () => ({ method: 'POST', url: PREVIEW_PATH }),
        res: (response: unknown) => ({ statusCode: httpStatusCode(response) }),
        err: (error: unknown) => ({
          type: 'Error', message: 'Manifest preview unavailable', statusCode: httpStatusCode(error),
        }),
        // Fastify can also put error.message or a refused URL in the log msg.
        msg: () => 'Service manifest request',
      },
    });
  },
  frameworkErrors(error, request, reply) {
    if (!isManifestRequest(request.raw.url)) return reply.send(error);
    reply.header('cache-control', 'no-store');
    const failure = manifestInputFailure(error);
    request.log.warn({ statusCode: failure.status }, 'Manifest preview unavailable');
    return reply.status(failure.status).send(failure.body);
  },
};

const serviceManifestPlugin: FastifyPluginAsync = async (fastify) => {
  // Encapsulated parser/error handler: malformed or oversized input never
  // returns parser excerpts, validator keys/values, or logs submitted data.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', {
    parseAs: 'string', bodyLimit: MANIFEST_BODY_LIMIT,
  }, (_request, body, done) => {
    if (typeof body !== 'string') {
      done(Object.assign(new Error('Invalid manifest JSON'), { statusCode: 400 }));
      return;
    }
    try {
      done(null, parseManifestJson(body));
    } catch {
      done(Object.assign(new Error('Invalid manifest JSON'), { statusCode: 400 }));
    }
  });
  fastify.setErrorHandler((error, request, reply) => {
    const failure = manifestInputFailure(error);
    // Never pass the raw error (which may retain input/cause) to the logger.
    request.log.warn({ statusCode: failure.status }, 'Manifest preview unavailable');
    return reply.status(failure.status).send(failure.body);
  });

  fastify.post(PREVIEW_PATH, {
    bodyLimit: MANIFEST_BODY_LIMIT,
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
