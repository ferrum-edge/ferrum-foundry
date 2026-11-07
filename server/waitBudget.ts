// Pure policy shared with the SPA; do not import server dependencies here.
export const APPLY_WAIT_MS = 25_000;
export const ACME_MAX_WAIT_MS = 600_000;
const TRANSPORT_MARGIN_MS = 5_000;

export function serverWaitTimeout(requestedWaitMs: number): number {
  return requestedWaitMs + TRANSPORT_MARGIN_MS;
}

const ACME_FINALIZE_PATH_PATTERN = /^\/admin\/tls\/acme\/orders\/[^/]+\/finalize$/;

export function waitingRouteTimeout(method: string, path: string): number {
  if (method === 'GET' && path === '/config/apply-status') {
    return serverWaitTimeout(serverWaitTimeout(APPLY_WAIT_MS));
  }
  if (method === 'POST' && ACME_FINALIZE_PATH_PATTERN.test(path)) {
    return serverWaitTimeout(serverWaitTimeout(ACME_MAX_WAIT_MS));
  }
  return 0;
}

// Shipped BFF budgets. The browser cannot observe runtime timeout overrides.
export const DEFAULT_RESPONSE_TIMEOUT = 60_000;
export const DEFAULT_UPLOAD_TIMEOUT = 300_000;
export const DEFAULT_WRITE_TIMEOUT = 60_000;
/** The response budget floor for backup and restore, whatever the read timeout. */
export const BACKUP_RESTORE_OPERATION_TIMEOUT = 120_000;

/**
 * Routes whose body may exceed the ordinary limit, and so get the upload
 * budget rather than the write budget. Each class has its own byte limit in
 * the BFF (`server/proxy.ts`).
 */
export type LargeUploadRoute = 'restore' | 'api-spec';

export function largeUploadRoute(path: string): LargeUploadRoute | null {
  if (path === '/restore') return 'restore';
  if (path === '/api-specs' || path.startsWith('/api-specs/')) return 'api-spec';
  return null;
}

/**
 * Requests whose response deadline the BFF floors at
 * `BACKUP_RESTORE_OPERATION_TIMEOUT`: a restore by any method, and a backup
 * download (`GET` only).
 */
export function isBackupRestoreOperation(method: string, path: string): boolean {
  return path === '/restore' || (method === 'GET' && path === '/backup');
}

/** Total browser budget, including upload before the response deadline starts. */
export function longRunningClientTimeout(method: string, path: string): number {
  const route = largeUploadRoute(path);
  const response = Math.max(
    DEFAULT_RESPONSE_TIMEOUT,
    route === 'restore' ? BACKUP_RESTORE_OPERATION_TIMEOUT : waitingRouteTimeout(method, path),
  );
  let upload = 0;
  if (method === 'POST' || method === 'PUT') {
    upload = route !== null ? DEFAULT_UPLOAD_TIMEOUT : DEFAULT_WRITE_TIMEOUT;
  }
  return serverWaitTimeout(upload + response);
}
