import type { FastifyPluginAsync } from 'fastify';
import { fetch } from 'undici';
import type { AuthPrincipal } from '../auth-types.js';
import { loadConfig, registerRuntimeConfigListener } from '../config.js';
import { generateToken } from '../jwt.js';
import { getDispatcher } from '../tls.js';
import { APP_VERSION } from '../version.js';

interface ReadinessResult {
  httpStatus: number;
  body: {
    status: 'ready' | 'degraded' | 'unavailable';
    ready: boolean;
    version: string;
    checkedAt: string;
    components: {
      bff: { status: 'ok' };
      gateway: { status: 'ok' | 'degraded' | 'unavailable'; httpStatus?: number };
    };
  };
}

const CACHE_TTL_MS = 5000;
let cached: { expiresAt: number; result: ReadinessResult } | undefined;
let inFlight: Promise<ReadinessResult> | undefined;

registerRuntimeConfigListener(() => {
  cached = undefined;
});

async function boundedJson(response: Awaited<ReturnType<typeof fetch>>): Promise<Record<string, unknown> | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) return undefined;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function probeReadiness(): Promise<ReadinessResult> {
  const config = loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.readTimeout, 10_000));
  timer.unref();
  const principal: AuthPrincipal = {
    subject: 'ferrum-foundry-readiness',
    displayName: 'Foundry readiness probe',
    role: 'viewer',
    namespaces: config.jwtNamespaces,
    authMode: config.authMode,
  };
  const checkedAt = new Date().toISOString();

  try {
    const token = await generateToken(config, principal);
    const response = await fetch(new URL('/health', config.adminUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      dispatcher: getDispatcher(config),
      redirect: 'error',
    });
    const gatewayBody = await boundedJson(response);
    const healthReady = response.ok && gatewayBody?.ready !== false;
    let authStatus = response.status;
    let authReady = false;
    if (healthReady) {
      // `/namespaces` is authenticated but fleet-global. Ferrum filters it to
      // JWT namespace claims when enforcement is enabled, so it proves that
      // authentication works without inventing a tenant for a global readiness
      // principal or failing when trusted-proxy deployments omit static grants.
      const authResponse = await fetch(new URL('/namespaces?offset=0&limit=1', config.adminUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
        dispatcher: getDispatcher(config),
        redirect: 'error',
      });
      authStatus = authResponse.status;
      authReady = authResponse.ok;
      await authResponse.body?.cancel().catch(() => undefined);
    }
    const gatewayReady = healthReady && authReady;
    const gatewayDegraded = gatewayReady && gatewayBody?.status === 'degraded';
    return {
      httpStatus: gatewayReady ? 200 : 503,
      body: {
        status: gatewayReady ? (gatewayDegraded ? 'degraded' : 'ready') : 'unavailable',
        ready: gatewayReady,
        version: APP_VERSION,
        checkedAt,
        components: {
          bff: { status: 'ok' },
          gateway: {
            status: gatewayReady ? (gatewayDegraded ? 'degraded' : 'ok') : 'unavailable',
            httpStatus: authStatus,
          },
        },
      },
    };
  } catch {
    return {
      httpStatus: 503,
      body: {
        status: 'unavailable',
        ready: false,
        version: APP_VERSION,
        checkedAt,
        components: {
          bff: { status: 'ok' },
          gateway: { status: 'unavailable' },
        },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readiness(): Promise<ReadinessResult> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.result;
  if (!inFlight) {
    inFlight = probeReadiness().then((result) => {
      cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
      return result;
    }).finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  const live = async () => ({ status: 'ok' as const, version: APP_VERSION });
  fastify.get('/api/health', live);
  fastify.get('/api/health/live', live);
  fastify.get('/api/health/ready', async (_request, reply) => {
    const result = await readiness();
    return reply.status(result.httpStatus).send(result.body);
  });
};

export default healthPlugin;
