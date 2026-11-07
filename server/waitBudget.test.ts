import { describe, expect, it } from 'vitest';
import {
  ACME_MAX_WAIT_MS,
  APPLY_WAIT_MS,
  BACKUP_RESTORE_OPERATION_TIMEOUT,
  isBackupRestoreOperation,
  largeUploadRoute,
  longRunningClientTimeout,
  serverWaitTimeout,
  waitingRouteTimeout,
} from './waitBudget.js';

describe('server-side wait policy', () => {
  it.each([
    ['GET', '/config/apply-status', APPLY_WAIT_MS],
    ['POST', '/admin/tls/acme/orders/example/finalize', ACME_MAX_WAIT_MS],
  ] as const)('keeps %s %s browser and BFF deadlines beyond the gateway budget', (method, path, wait) => {
    expect(serverWaitTimeout(wait)).toBe(wait + 5_000);
    expect(waitingRouteTimeout(method, path)).toBe(wait + 10_000);
  });

  it('does not extend unrelated routes or methods', () => {
    expect(waitingRouteTimeout('POST', '/config/apply-status')).toBe(0);
    expect(waitingRouteTimeout('GET', '/admin/tls/acme/orders/example/finalize')).toBe(0);
    expect(waitingRouteTimeout('POST', '/admin/tls/acme/orders')).toBe(0);
  });
});

it.each([
  ['POST', '/api-specs', 300_000, 60_000],
  ['PUT', '/api-specs/example', 300_000, 60_000],
  ['GET', '/api-specs/example', 0, 60_000],
  ['POST', '/admin/tls/acme/orders', 60_000, 60_000],
  ['POST', '/admin/tls/acme/renew/example', 60_000, 60_000],
  // Restore admits a 110 MiB body over the upload budget, then waits at least
  // the backup/restore operation budget for Edge's answer.
  ['POST', '/restore', 300_000, BACKUP_RESTORE_OPERATION_TIMEOUT],
  // A backup download waits the same operation budget, with no upload.
  ['GET', '/backup', 0, BACKUP_RESTORE_OPERATION_TIMEOUT],
  ['HEAD', '/backup', 0, 60_000],
] as const)('covers upload and response budgets for %s %s', (method, path, upload, response) => {
  expect(longRunningClientTimeout(method, path)).toBe(upload + response + 5_000);
});

// One route classification for the BFF's body limits and upload deadlines
// (server/proxy.ts) and the browser's budget above.
it.each([
  ['/restore', 'restore'],
  ['/api-specs', 'api-spec'],
  ['/api-specs/example', 'api-spec'],
  ['/api-specs/example/document', 'api-spec'],
  // Trailing-slash and look-alike spellings stay ordinary (2 MiB, write budget).
  ['/restore/', null],
  ['/api-specsx', null],
  ['/backup', null],
  ['/proxies', null],
] as const)('classifies %s as large upload route %s', (path, route) => {
  expect(largeUploadRoute(path)).toBe(route);
});

it.each([
  ['POST', '/restore', true],
  ['GET', '/restore', true],
  ['GET', '/backup', true],
  // HEAD /backup is a long read for admission (isLongRead in server/proxy.ts),
  // but only GET has had the floored response deadline.
  ['HEAD', '/backup', false],
  ['POST', '/backup', false],
  ['GET', '/backup/', false],
  ['GET', '/restore/', false],
  ['GET', '/proxies', false],
] as const)('floors %s %s at the backup/restore operation budget: %s', (method, path, floored) => {
  expect(isBackupRestoreOperation(method, path)).toBe(floored);
});
