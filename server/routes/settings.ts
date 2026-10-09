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
import { projectHealthSummary } from '../health-summary.js';
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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
    // BFF settings are fleet-wide: the gateway target, TLS trust, signing, and
    // the static login defaults apply to every session and every namespace.
    // A session holding namespace grants may not change them, whatever its role
    // and whatever the body names; only an unrestricted admin may.
    if (request.authPrincipal?.namespaces !== undefined) {
      request.log.warn({
        actor: request.authPrincipal.subject,
      }, 'Namespace-scoped settings change refused');
      return reply.status(403).send({
        error: 'Namespace-scoped sessions cannot change BFF settings',
        code: 'FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED',
      });
    }

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

    if ('jwtNamespaces' in body && !isStringArray(body.jwtNamespaces)) {
      return reply.status(400).send({
        error: 'Settings validation failed',
        code: 'FERRUM_BFF_INVALID_SETTINGS',
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
      // Edge v0.9.15 and earlier return the detailed health view to an
      // `ns`-claim JWT; v0.9.16+ return the tenant or minimal tier. Either way
      // a namespace-scoped session receives only the summary fields
      // `/api/proxy/health` gives it, and never raw text.
      if (principal.namespaces !== undefined) {
        body = typeof body === 'string' ? undefined : projectHealthSummary(body, principal.namespaces);
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
