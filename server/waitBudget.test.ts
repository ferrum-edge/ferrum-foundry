import { describe, expect, it } from 'vitest';
import {
  ACME_MAX_WAIT_MS,
  APPLY_WAIT_MS,
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
] as const)('covers upload and response budgets for %s %s', (method, path, upload, response) => {
  expect(longRunningClientTimeout(method, path)).toBe(upload + response + 5_000);
});
