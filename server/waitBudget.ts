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

// Shipped BFF budgets. The browser cannot observe runtime timeout overrides.
export const DEFAULT_RESPONSE_TIMEOUT = 60_000;
export const DEFAULT_UPLOAD_TIMEOUT = 300_000;
export const DEFAULT_WRITE_TIMEOUT = 60_000;

/** Total browser budget, including upload before the response deadline starts. */
export function longRunningClientTimeout(method: string, path: string): number {
  const response = Math.max(DEFAULT_RESPONSE_TIMEOUT, waitingRouteTimeout(method, path));
  const largeUpload = path === '/api-specs' || path.startsWith('/api-specs/');
  let upload = 0;
  if (method === 'POST' || method === 'PUT') {
    upload = largeUpload ? DEFAULT_UPLOAD_TIMEOUT : DEFAULT_WRITE_TIMEOUT;
  }
  return serverWaitTimeout(upload + response);
}
