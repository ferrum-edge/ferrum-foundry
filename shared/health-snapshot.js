/**
 * Recognition of a Ferrum Edge `/health` snapshot, shared by the BFF and the
 * SPA. Pure: no Node or browser APIs, so Vite can bundle it.
 *
 * Edge answers `/health` with `200` when ready and with `503` carrying the same
 * structured body when it is not (`starting`, `degraded`, `unavailable`,
 * `draining`). Only a recognized `status` with a boolean `ready` is an
 * observation of the gateway; anything else that answers at the admin origin
 * (a proxy's HTML or text page, `{ "error": ... }`, `{}`) is not.
 */

/** The `status` values a gateway health snapshot reports. */
export const GATEWAY_HEALTH_STATUSES = Object.freeze(['ok', 'degraded', 'starting', 'unavailable', 'draining']);

const STATUSES = new Set(GATEWAY_HEALTH_STATUSES);

/** Whether `body` (a parsed JSON value) is a gateway health snapshot. */
export function isGatewayHealthSnapshot(body) {
  return body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    STATUSES.has(body.status) &&
    typeof body.ready === 'boolean';
}

/**
 * Whether an HTTP `/health` answer is an observation of the gateway: a `200`
 * or `503` whose parsed body is a health snapshot.
 */
export function isGatewayHealthAnswer(httpStatus, body) {
  return (httpStatus === 200 || httpStatus === 503) && isGatewayHealthSnapshot(body);
}
