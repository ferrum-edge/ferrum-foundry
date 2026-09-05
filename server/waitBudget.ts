// Pure policy shared with the SPA; do not import server dependencies here.
export const APPLY_WAIT_MS = 25_000;
export const ACME_MAX_WAIT_MS = 600_000;
const TRANSPORT_MARGIN_MS = 5_000;

export function serverWaitTimeout(requestedWaitMs: number): number {
  return requestedWaitMs + TRANSPORT_MARGIN_MS;
}

export function waitingRouteTimeout(method: string, path: string): number {
  if (method === 'GET' && path === '/config/apply-status') {
    return serverWaitTimeout(serverWaitTimeout(APPLY_WAIT_MS));
  }
  if (method === 'POST' && /^\/admin\/tls\/acme\/orders\/[^/]+\/finalize$/.test(path)) {
    return serverWaitTimeout(serverWaitTimeout(ACME_MAX_WAIT_MS));
  }
  return 0;
}
