import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { resolvePrincipal } from '../auth.js';
import type { AuthPrincipal } from '../auth-types.js';
import { loadConfig, registerRuntimeConfigListener } from '../config.js';
import { generateToken } from '../jwt.js';
import { getProbeDispatcher } from '../tls.js';
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
let generation = 0;

registerRuntimeConfigListener(() => {
  generation += 1;
  cached = undefined;
  inFlight = undefined;
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

// The statuses a gateway health snapshot reports, as `getHealth`
// (src/api/metrics.ts) accepts them.
const GATEWAY_HEALTH_STATUSES: ReadonlySet<unknown> = new Set(['ok', 'degraded', 'starting', 'unavailable', 'draining']);

/**
 * The gateway's own verdict, or `undefined` when the body is not a health
 * snapshot at all: absent, unparseable, oversized, `{}`, or a fallback page
 * from whatever else answers at the admin origin. Only a recognized status
 * with a boolean `ready` is an observation of the gateway.
 */
function healthSnapshot(body: Record<string, unknown> | undefined): { status: string; ready: boolean } | undefined {
  if (!body || !GATEWAY_HEALTH_STATUSES.has(body.status) || typeof body.ready !== 'boolean') return undefined;
  return { status: body.status as string, ready: body.ready };
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
      dispatcher: getProbeDispatcher(config),
      redirect: 'error',
    });
    const snapshot = healthSnapshot(await boundedJson(response));
    // A 2xx without a valid snapshot proves only that something answered, not
    // that the gateway is ready, so it is never a positive verdict.
    const healthReady = response.ok && snapshot?.ready === true;
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
        dispatcher: getProbeDispatcher(config),
        redirect: 'error',
      });
      authStatus = authResponse.status;
      authReady = authResponse.ok;
      await authResponse.body?.cancel().catch(() => undefined);
    }
    const gatewayReady = healthReady && authReady;
    const gatewayDegraded = gatewayReady && snapshot?.status === 'degraded';
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
    const acceptedGeneration = generation;
    const probe = probeReadiness().then((result) => {
      if (generation === acceptedGeneration) {
        cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return result;
    }).finally(() => {
      if (inFlight === probe) inFlight = undefined;
    });
    inFlight = probe;
  }
  return inFlight;
}

/**
 * What an unauthenticated caller is told (issue #592).
 *
 * Liveness and readiness probes key on the status code, and a monitor needs
 * the verdict, so both stay public. The Foundry version and the gateway's own
 * state (its `degraded` verdict and the Admin API status code) fingerprint the
 * deployment and describe a system the caller could not otherwise see, so only
 * an authenticated session reads them. A `degraded` gateway is still ready.
 */
function publicReadiness(
  body: ReadinessResult['body'],
): { status: 'ready' | 'unavailable'; ready: boolean } {
  return { status: body.ready ? 'ready' : 'unavailable', ready: body.ready };
}

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  const live = async (request: FastifyRequest) => (
    await resolvePrincipal(request)
      ? { status: 'ok' as const, version: APP_VERSION }
      : { status: 'ok' as const }
  );
  fastify.get('/api/health', live);
  fastify.get('/api/health/live', live);
  fastify.get('/api/health/ready', async (request, reply) => {
    const result = await readiness();
    const body = await resolvePrincipal(request) ? result.body : publicReadiness(result.body);
    return reply.status(result.httpStatus).send(body);
  });
};

export default healthPlugin;
