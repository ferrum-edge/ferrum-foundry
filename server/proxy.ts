import type { FastifyPluginAsync } from 'fastify';
import { fetch, Agent } from 'undici';
import { loadConfig } from './config.js';
import { createHttpAgent } from './tls.js';
import { generateToken } from './jwt.js';

const proxyPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.all('/api/proxy/*', async (request, reply) => {
    const config = loadConfig();
    const token = await generateToken(config);

    // Strip /api/proxy prefix from the URL
    const wildcardParam = (request.params as Record<string, string>)['*'];
    const targetPath = wildcardParam ? `/${wildcardParam}` : '/';
    const queryString = request.url.includes('?')
      ? '?' + request.url.split('?').slice(1).join('?')
      : '';
    const targetUrl = `${config.adminUrl}${targetPath}${queryString}`;

    // Build outgoing headers
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
    };

    // Content-Type passthrough
    const contentType = request.headers['content-type'];
    if (contentType) {
      headers['content-type'] = contentType;
    }

    // Pass through X-Ferrum-Namespace header
    const namespace = request.headers['x-ferrum-namespace'];
    if (namespace) {
      headers['x-ferrum-namespace'] = Array.isArray(namespace) ? namespace[0] : namespace;
    }

    // Build request body
    const method = request.method as string;
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const body = hasBody ? JSON.stringify(request.body) : undefined;

    // Set up abort controller for read timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.readTimeout);

    try {
      // Create an undici Agent with connect timeout and TLS settings
      const isHttps = config.adminUrl.startsWith('https://');
      const agentOptions: Agent.Options = {
        connect: {
          timeout: config.connectTimeout,
          ...(isHttps && {
            rejectUnauthorized: config.tlsVerify,
            ...(config.tlsCaPath && {
              ca: (await import('node:fs')).readFileSync(config.tlsCaPath, 'utf-8'),
            }),
          }),
        },
      };
      const dispatcher = new Agent(agentOptions);

      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
        dispatcher,
      });

      clearTimeout(timeoutId);

      // Forward status code
      reply.status(response.status);

      // Forward selected response headers
      const responseContentType = response.headers.get('content-type');
      if (responseContentType) {
        reply.header('content-type', responseContentType);
      }
      const responseContentLength = response.headers.get('content-length');
      if (responseContentLength) {
        reply.header('content-length', responseContentLength);
      }

      // Stream body back
      if (response.body) {
        return reply.send(response.body);
      }

      return reply.send();
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      const message = err instanceof Error ? err.message : 'Unknown proxy error';

      if (err instanceof Error && err.name === 'AbortError') {
        return reply.status(504).send({ error: 'Gateway Timeout', message: 'Upstream request timed out' });
      }

      fastify.log.error({ err, targetUrl }, 'Proxy request failed');
      return reply.status(502).send({ error: 'Bad Gateway', message });
    }
  });
};

export default proxyPlugin;
