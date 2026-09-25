import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

/**
 * Gateway target identity
 * -----------------------
 * A namespace header does not distinguish the `demo` namespace on gateway A
 * from the `demo` namespace on gateway B, and with runtime settings enabled an
 * accepted `adminUrl` change silently re-points every later request. So every
 * gateway-facing BFF response names the target it resolved against, and a
 * request that declares the target it was issued for is refused — before
 * anything is signed or forwarded — when that is no longer the current one.
 *
 * The identifier is a keyed digest of the configured admin origin: it is
 * stable across restarts and replicas that point at the same gateway, it
 * changes exactly when the destination does, and it does not disclose the
 * admin origin to principals that may not read the settings. See
 * `docs/authentication.md` → "Gateway target binding".
 */
export const GATEWAY_TARGET_HEADER = 'x-foundry-gateway-target';
export const GATEWAY_TARGET_CHANGED_CODE = 'FERRUM_BFF_GATEWAY_TARGET_CHANGED';

// Domain-separated key derivation so this digest can never be confused with
// any other use of the admin JWT signing secret.
const TARGET_KEY_LABEL = 'ferrum-foundry-gateway-target-v1';
let targetKeyCache: { secret: string; key: Buffer } | undefined;

function targetKey(secret: string): Buffer {
  if (targetKeyCache?.secret !== secret) {
    targetKeyCache = { secret, key: createHmac('sha256', secret).update(TARGET_KEY_LABEL).digest() };
  }
  return targetKeyCache.key;
}

export function gatewayTargetId(config: Pick<Config, 'adminUrl' | 'jwtSecret'>): string {
  return createHmac('sha256', targetKey(config.jwtSecret))
    .update(config.adminUrl)
    .digest('base64url')
    .slice(0, 32);
}

function declaredTarget(request: FastifyRequest): string | undefined {
  const value = request.headers[GATEWAY_TARGET_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Name the target `config` resolves to on `reply`, and report whether the
 * request may proceed against it. A request that declares no target is not
 * bound to one; a request that declares any other target must be refused.
 *
 * Call this synchronously with the `loadConfig()` whose `adminUrl` the
 * handler will use, so no settings change can land between the check and the
 * destination it approved.
 */
export function stampGatewayTarget(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Pick<Config, 'adminUrl' | 'jwtSecret'>,
): boolean {
  const current = gatewayTargetId(config);
  reply.header(GATEWAY_TARGET_HEADER, current);
  const declared = declaredTarget(request);
  return declared === undefined || declared === current;
}

/** Refuse a request issued against a gateway target that has been replaced. */
export function rejectStaleGatewayTarget(reply: FastifyReply): FastifyReply {
  return reply.status(409).send({
    error: 'The gateway target changed; reload Foundry before continuing',
    code: GATEWAY_TARGET_CHANGED_CODE,
  });
}
