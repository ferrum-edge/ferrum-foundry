import type { FastifyPluginAsync } from 'fastify';
import { fetch } from 'undici';
import { requireRole } from '../auth.js';
import {
  getPublicRuntimeConfig,
  loadConfig,
  updateRuntimeConfig,
  type RuntimeConfig,
} from '../config.js';
import {
  GATEWAY_TARGET_HEADER,
  gatewayTargetId,
  rejectStaleGatewayTarget,
  stampGatewayTarget,
} from '../gateway-target.js';
import { generateToken } from '../jwt.js';
import { getDispatcher } from '../tls.js';

const ALLOWED_UPDATE_FIELDS = new Set<keyof RuntimeConfig>([
  'adminUrl',
  'jwtIssuer',
  'jwtTtl',
  'jwtRole',
  'jwtAudience',
  'jwtNamespaces',
  'tlsCaPath',
  'tlsVerify',
  'connectTimeout',
  'readTimeout',
  'writeTimeout',
]);

// Empty entries are dropped by the grant parser, so they widen nothing; a list
// with no entry left is refused there as malformed.
function grantsAreWithin(requested: unknown, held: readonly string[]): boolean {
  return Array.isArray(requested) && requested.every((entry) => (
    typeof entry === 'string' && (entry.trim() === '' || held.includes(entry.trim()))
  ));
}

/** Bounded, log-safe summary of a refused grant request (grants are not secrets). */
function describeRequestedGrants(requested: unknown): unknown {
  if (!Array.isArray(requested)) return `[${typeof requested}]`;
  return requested.slice(0, 32).map((entry) => (
    typeof entry === 'string' ? entry.slice(0, 254) : `[${typeof entry}]`
  ));
}

async function readBoundedBody(response: Awaited<ReturnType<typeof fetch>>, maxBytes = 64 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error('Gateway status response exceeded the permitted size');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const settingsPlugin: FastifyPluginAsync = async (fastify) => {
  const requireAdmin = requireRole('admin');

  fastify.get('/api/settings', { onRequest: requireAdmin }, async (request, reply) => {
    // A settings form seeded from this read belongs to the target it names.
    stampGatewayTarget(request, reply, loadConfig());
    return getPublicRuntimeConfig();
  });

  fastify.put('/api/settings', { onRequest: requireAdmin, bodyLimit: 32 * 1024 }, async (request, reply) => {
    const config = loadConfig();
    if (!config.allowRuntimeSettings) {
      return reply.status(403).send({
        error: 'Runtime settings are disabled',
        code: 'FERRUM_BFF_SETTINGS_IMMUTABLE',
      });
    }

    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return reply.status(400).send({ error: 'Settings body must be an object' });
    }
    const body = request.body as Record<string, unknown>;
    const unknownFields = Object.keys(body).filter((key) => !ALLOWED_UPDATE_FIELDS.has(key as keyof RuntimeConfig));
    if (unknownFields.length > 0) {
      return reply.status(400).send({ error: 'Settings body contains unsupported fields' });
    }

    if (config.authMode === 'trusted-proxy' && ('jwtRole' in body || 'jwtNamespaces' in body)) {
      return reply.status(400).send({
        error: 'Role and namespace grants are managed by the trusted identity proxy',
        code: 'FERRUM_BFF_PROXY_MANAGED_IDENTITY',
      });
    }

    // A scoped session may narrow the static grants but never widen them: it
    // cannot grant a namespace it does not hold, or every namespace.
    const heldGrants = request.authPrincipal?.namespaces;
    if (heldGrants && 'jwtNamespaces' in body && !grantsAreWithin(body.jwtNamespaces, heldGrants)) {
      request.log.warn({
        actor: request.authPrincipal?.subject,
        requested: describeRequestedGrants(body.jwtNamespaces),
      }, 'Namespace grant widening refused');
      return reply.status(403).send({
        error: 'Namespace grants cannot exceed the grants of this session',
        code: 'FERRUM_BFF_NAMESPACE_GRANT_EXCEEDED',
      });
    }

    // The form resubmits every field it was seeded with, `adminUrl` included,
    // so a save drafted against a replaced target would silently revert it.
    if (!stampGatewayTarget(request, reply, config)) return rejectStaleGatewayTarget(reply);

    try {
      const before = getPublicRuntimeConfig();
      const accepted = await updateRuntimeConfig(body as Partial<RuntimeConfig>);
      const after = getPublicRuntimeConfig(accepted);
      const changedFields = Object.keys(body);
      fastify.log.info({
        actor: request.authPrincipal?.subject,
        changedFields,
        changes: Object.fromEntries(changedFields.map((field) => [
          field,
          field === 'adminUrl' || field === 'tlsCaPath'
            ? '[redacted connection setting]'
            : { before: before[field as keyof typeof before], after: after[field as keyof typeof after] },
        ])),
      }, 'Runtime settings changed');
      reply.header(GATEWAY_TARGET_HEADER, gatewayTargetId({ ...config, adminUrl: accepted.adminUrl }));
      return after;
    } catch {
      return reply.status(400).send({
        error: 'Settings validation failed',
        code: 'FERRUM_BFF_INVALID_SETTINGS',
      });
    }
  });

  fastify.get('/api/settings/status', { onRequest: requireAdmin }, async (request, reply) => {
    const config = loadConfig();
    const principal = request.authPrincipal;
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    if (!stampGatewayTarget(request, reply, config)) return rejectStaleGatewayTarget(reply);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.readTimeout);
    timeout.unref();
    try {
      const token = await generateToken(config, principal);
      const response = await fetch(new URL('/health', config.adminUrl), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
        dispatcher: getDispatcher(config),
        redirect: 'error',
      });
      const rawBody = await readBoundedBody(response);
      let body: unknown = rawBody;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // The gateway may return text for a proxy/intermediary failure.
      }
      return reply.status(response.status).send({
        reachable: response.ok,
        status: response.status,
        body,
      });
    } catch (error: unknown) {
      const timeoutFailure = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return reply.status(timeoutFailure ? 504 : 502).send({
        reachable: false,
        code: timeoutFailure ? 'FERRUM_BFF_TIMEOUT' : 'FERRUM_BFF_UPSTREAM_FAILURE',
      });
    } finally {
      clearTimeout(timeout);
    }
  });
};

export default settingsPlugin;
