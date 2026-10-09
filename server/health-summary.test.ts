import { describe, expect, it } from 'vitest';
import { projectHealthSummary } from './health-summary.js';

const GRANTS = ['tenant-a', 'tenant-c'];
const SERVING_TENANT_A = {
  active: 'tenant-a',
  serving_scope: 'single-namespace-data-plane',
  data_plane_single_namespace: true,
};

describe('scoped health summary', () => {
  it('reduces the Edge v0.9.15 detailed tier to the summary fields', () => {
    expect(projectHealthSummary({
      status: 'ok',
      timestamp: '2026-10-09T00:00:00Z',
      mode: 'database',
      admin_writes_enabled: true,
      ready: true,
      database: { connected: true },
      gateway_listeners: { failures: [] },
      cached_config: { proxies: 4 },
      namespace: SERVING_TENANT_A,
    }, GRANTS)).toEqual({
      status: 'ok',
      timestamp: '2026-10-09T00:00:00Z',
      mode: 'database',
      admin_writes_enabled: true,
      ready: true,
      namespace: SERVING_TENANT_A,
    });
  });

  it('accepts the Edge v0.9.16 tenant tier unchanged', () => {
    const tenant = {
      status: 'degraded',
      ready: false,
      mode: 'database',
      admin_writes_enabled: false,
      namespace: SERVING_TENANT_A,
    };
    expect(projectHealthSummary(tenant, GRANTS)).toEqual(tenant);
  });

  it('accepts the Edge v0.9.16 minimal tier, concluding nothing about the mode', () => {
    expect(projectHealthSummary({ status: 'ok', ready: true }, GRANTS)).toEqual({ status: 'ok', ready: true });
  });

  it('withholds a namespace block whose active namespace is not granted', () => {
    for (const namespace of [
      { ...SERVING_TENANT_A, active: 'tenant-b' },
      { ...SERVING_TENANT_A, active: null },
      { serving_scope: 'control-plane', data_plane_single_namespace: false },
      'tenant-a',
      ['tenant-a'],
      null,
    ]) {
      const summary = projectHealthSummary({ status: 'ok', ready: true, namespace }, GRANTS);
      expect(summary).toEqual({ status: 'ok', ready: true });
    }
    expect(projectHealthSummary({ status: 'ok', namespace: SERVING_TENANT_A }, [])).toEqual({ status: 'ok' });
  });

  it('keeps only the scalar fields of a granted namespace block', () => {
    expect(projectHealthSummary({
      namespace: { ...SERVING_TENANT_A, routes: { count: 3 }, listeners: [8443] },
    }, GRANTS)).toEqual({ namespace: SERVING_TENANT_A });
  });

  it('drops summary fields that are objects', () => {
    expect(projectHealthSummary({ status: { nested: 'ok' }, mode: ['database'], ready: true }, GRANTS))
      .toEqual({ ready: true });
  });

  it.each([[null], [[]], ['ok'], [3], [true]])('has no summary for the non-object body %j', (body) => {
    expect(projectHealthSummary(body, GRANTS)).toBeUndefined();
  });
});
