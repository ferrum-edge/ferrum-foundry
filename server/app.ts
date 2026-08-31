import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from './auth.js';
import { loadConfig } from './config.js';
import proxyPlugin from './proxy.js';
import { requestIsApiRoute } from './proxy-path.js';
import healthPlugin from './routes/health.js';
import settingsPlugin from './routes/settings.js';
import { closeDispatchers } from './tls.js';

export interface BuildAppOptions {
  serveStatic?: boolean;
  logger?: boolean;
}

const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig();
  const isProduction = process.env.NODE_ENV === 'production';
  const serveStatic = options.serveStatic ?? isProduction;
  const fastify = Fastify({
    logger: options.logger ?? {
      level: isProduction ? 'info' : 'debug',
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: isProduction ? 1 : false,
  });

  await fastify.register(cookie);
  await fastify.register(cors, { origin: isProduction ? false : true });
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: config.enableHsts
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header(
      'permissions-policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    if (requestIsApiRoute(request) && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  await fastify.register(authPlugin);
  await fastify.register(healthPlugin);
  await fastify.register(settingsPlugin);
  await fastify.register(proxyPlugin);

  if (serveStatic) {
    const here = dirname(fileURLToPath(import.meta.url));
    const distPath = join(here, '..', 'dist');
    const fastifyStatic = (await import('@fastify/static')).default;
    await fastify.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
      wildcard: false,
      setHeaders(response, pathName) {
        const filename = pathName.slice(distPath.length + 1);
        if (filename === 'index.html' || filename === 'theme-bootstrap.js') {
          response.header('cache-control', 'no-cache, no-store, must-revalidate');
        } else if (HASHED_ASSET_PATTERN.test(filename) && extname(filename)) {
          response.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          response.header('cache-control', 'public, max-age=3600');
        }
      },
    });

    fastify.setNotFoundHandler(async (request, reply) => {
      if (requestIsApiRoute(request)) return reply.status(404).send({ error: 'Not Found' });
      reply.header('cache-control', 'no-cache, no-store, must-revalidate');
      return reply.sendFile('index.html');
    });
  }

  fastify.addHook('onClose', async () => closeDispatchers());
  return fastify;
}
