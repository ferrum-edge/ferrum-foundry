import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, settle, stubFetch } from '@/test/__tests__/harness';
import { adverseHealth, detailedHealth, logSink } from '@/test/__tests__/healthFixtures';
import { formatDateTime } from '@/lib/format';
import { healthFindings } from '@/components/health/OperationalHealthCards';
import type { HealthResponse } from '@/api/types';
import StatusPage from './index';

vi.mock('@/stores/namespace', () => ({ useNamespace: () => ({ scope: { namespace: 'tenant-a' } }) }));
vi.mock('@/components/shared/BffConnectionCard', () => ({ BffConnectionCard: () => null }));
let harness: ReturnType<typeof createHarness>;
beforeEach(() => { harness = createHarness(); });
afterEach(async () => { await harness.dispose(); vi.unstubAllGlobals(); });

const region = (name: string) => harness.host.querySelector(`[role="region"][aria-label="${name}"]`);

describe('authenticated operator health', () => {
  it('surfaces all diagnostic sections and adverse detail even with a coarse OK', async () => {
    stubFetch(() => Response.json(adverseHealth));
    await harness.render(<StatusPage />);
    await settle(() => expect(harness.host.textContent).toContain('Operational diagnostics need attention'));
    for (const name of ['Gateway listeners', 'Serving listener failures', 'Database polling', 'Namespace serving scope',
      'Remote JWKS trust', 'Process logging · stdout', 'Process logging · stderr', 'Plugin log record loss',
      'Kafka logging', 'AI transcript audit', 'Admin audit pipeline', 'Service discovery', 'CP/DP verification trust',
      'Data plane configuration', 'Shared replay authority', 'Mesh runtime health']) expect(region(name), name).not.toBeNull();
    expect(region('Gateway listeners')?.textContent).toContain('9443');
    expect(region('Gateway listeners')?.textContent).toContain('Failure details truncated');
    expect(region('Gateway listeners')?.textContent).toContain('counts cover tracked identities only');
    expect(region('Database polling')?.textContent).toContain('Periodic polling remains authoritative');
    expect(region('Plugin log record loss')?.textContent).toContain('api_chargeback_sink');
    expect(region('Admin audit pipeline')?.textContent).toContain('HTTP 503 before they run');
    const ok = [...harness.host.querySelectorAll('span')].find(el => el.textContent === 'OK');
    expect(ok?.className).toContain('text-warning');
  });

  it('keeps omitted sections absent and distinguishes null/unknown from zero', async () => {
    stubFetch(() => Response.json({ ...detailedHealth, logging: { stdout: null, stderr: null },
      database: { status: 'connected', pool: { size: 2 } }, kafka_logging: [], ai_transcript_audit: [] }));
    await harness.render(<StatusPage />);
    await settle(() => expect(harness.host.textContent).toContain('No sink snapshot'));
    expect(region('Gateway listeners')).toBeNull();
    expect(region('Remote JWKS trust')).toBeNull();
    expect(harness.host.textContent).toContain('unknown active');
    expect(harness.host.textContent).toContain('No Kafka sink generations reported');
    expect(harness.host.textContent).toContain('No AI transcript audit instances reported');
  });

  it('marks cumulative loss as history even after a sink recovers', async () => {
    stubFetch(() => Response.json({ ...detailedHealth, logging: { stdout: logSink, stderr: null } }));
    await harness.render(<StatusPage />);
    await settle(() => expect(region('Process logging · stdout')?.textContent).toContain('Historical failures / loss'));
    expect(region('Process logging · stdout')?.textContent).toContain('not a current failure rate');
    expect(region('Process logging · stdout')?.className).toContain('border-warning');
  });

  it('does not keep a green process verdict after a refresh failure', async () => {
    let failed = false;
    stubFetch(() => { if (failed) throw new TypeError('offline'); return Response.json(detailedHealth); });
    await harness.render(<StatusPage />);
    await settle(() => expect(harness.host.textContent).toContain('Collection disabled'));
    failed = true;
    await act(async () => { await harness.client.refetchQueries({ queryKey: ['health'] }); });
    await settle(() => expect(harness.host.textContent).toContain('Health status could not refresh'));
    expect(harness.host.textContent).not.toContain('Collection disabled');
    expect(harness.host.textContent).not.toContain('Ready');
  });
});

describe('database mTLS DNS admission fence', () => {
  const OLDEST = 1_763_683_200_000;
  // Edge keeps the coarse verdict and the database status healthy while fenced.
  const fenced: HealthResponse = {
    ...detailedHealth,
    database: {
      status: 'connected', type: 'mongodb',
      mtls_dns_admission_fence: {
        fenced: true, retained_fences: 2, namespaces: ['tenant-a', 'tenant-b'], oldest_retained_since_unix_ms: OLDEST,
      },
    },
  };

  it('is an operational finding only while fenced', () => {
    expect(healthFindings(fenced)).toContain('Database mTLS DNS admission fenced');
    expect(healthFindings({ ...detailedHealth, database: { status: 'connected' } })).toEqual([]);
    expect(healthFindings(detailedHealth)).toEqual([]);
  });

  it('alerts and renders the fence under the Database card despite a coarse OK', async () => {
    stubFetch(() => Response.json(fenced));
    await harness.render(<StatusPage />);
    await settle(() => expect(harness.host.textContent).toContain('Operational diagnostics need attention'));
    const findings = harness.host.querySelector('[role="status"]');
    expect(findings?.textContent).toContain('Database mTLS DNS admission fenced');
    const fence = region('mTLS DNS admission fence');
    expect(fence).not.toBeNull();
    const databaseCard = [...harness.host.querySelectorAll('h2')].find((h) => h.textContent === 'Database')?.parentElement;
    expect(databaseCard?.contains(fence ?? null)).toBe(true);
    expect(fence?.textContent).toContain('fail closed with HTTP 503');
    expect(fence?.textContent).not.toContain('uncertain');
    expect(fence?.textContent).toContain('other namespaces are unaffected');
    expect(fence?.textContent).toContain('Normally a fence clears');
    expect(fence?.textContent).toContain('restart the process');
    expect(fence?.querySelector('a')?.getAttribute('href'))
      .toBe('https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/mongodb.md#retained-mtls-dns-admission-fences');
    const fields = Object.fromEntries([...(fence?.querySelectorAll('dl > div') ?? [])]
      .map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
    expect(fields).toEqual({
      'Retained fences': '2',
      'Oldest retained since': formatDateTime(OLDEST),
      Namespaces: 'tenant-a, tenant-b',
    });
  });

  it('reports an absent oldest timestamp as not reported', async () => {
    const { oldest_retained_since_unix_ms: _omitted, ...fence } = fenced.database!.mtls_dns_admission_fence!;
    stubFetch(() => Response.json({ ...fenced, database: { ...fenced.database, mtls_dns_admission_fence: fence } }));
    await harness.render(<StatusPage />);
    await settle(() => expect(region('mTLS DNS admission fence')).not.toBeNull());
    expect(region('mTLS DNS admission fence')?.textContent).toContain('Oldest retained sinceNot reported');
  });

  const fenceFields = () => Object.fromEntries([...(region('mTLS DNS admission fence')?.querySelectorAll('dl > div') ?? [])]
    .map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));

  it('keeps the alert but reports malformed details as not reported', async () => {
    const malformed = { fenced: true, retained_fences: { count: 2 }, namespaces: ['tenant-a', { name: 'tenant-b' }, 7],
      oldest_retained_since_unix_ms: 'yesterday' };
    stubFetch(() => Response.json({ ...fenced, database: { ...fenced.database, mtls_dns_admission_fence: malformed } }));
    await harness.render(<StatusPage />);
    await settle(() => expect(region('mTLS DNS admission fence')).not.toBeNull());
    expect(harness.host.querySelector('[role="status"]')?.textContent).toContain('Database mTLS DNS admission fenced');
    expect(fenceFields()).toEqual({
      'Retained fences': 'Not reported',
      'Oldest retained since': 'Not reported',
      Namespaces: 'Not reported',
    });
    // Without a usable list, no namespace is called unaffected.
    const text = region('mTLS DNS admission fence')?.textContent;
    expect(text).toContain('mTLS DNS admissions for the affected namespaces fail closed with HTTP 503');
    expect(text).not.toContain('other namespaces are unaffected');
    expect(text).not.toContain('tenant-a');
  });

  it.each([
    ['a zero count', { retained_fences: 0 }, 'Retained fences'],
    ['a negative count', { retained_fences: -1 }, 'Retained fences'],
    ['a fractional count', { retained_fences: 1.5 }, 'Retained fences'],
    ['a negative timestamp', { oldest_retained_since_unix_ms: -1 }, 'Oldest retained since'],
    ['a fractional timestamp', { oldest_retained_since_unix_ms: 1.5 }, 'Oldest retained since'],
    ['a timestamp past the Date range', { oldest_retained_since_unix_ms: 8.64e15 + 1 }, 'Oldest retained since'],
    ['an empty namespace list', { namespaces: [] }, 'Namespaces'],
  ])('reports %s as not reported and keeps the alert', async (_label, override, field) => {
    stubFetch(() => Response.json({ ...fenced, database: { ...fenced.database,
      mtls_dns_admission_fence: { ...fenced.database!.mtls_dns_admission_fence, ...override } } }));
    await harness.render(<StatusPage />);
    await settle(() => expect(region('mTLS DNS admission fence')).not.toBeNull());
    expect(fenceFields()[field]).toBe('Not reported');
    expect(harness.host.querySelector('[role="status"]')?.textContent).toContain('Database mTLS DNS admission fenced');
  });

  it.each([['the string "false"', 'false'], ['the string "true"', 'true'], ['false', false]])(
    'shows no fence and no finding for a fenced flag of %s', async (_label, flag) => {
      const body = { ...fenced, database: { ...fenced.database,
        mtls_dns_admission_fence: { ...fenced.database!.mtls_dns_admission_fence, fenced: flag } } };
      expect(healthFindings(body as HealthResponse)).toEqual([]);
      stubFetch(() => Response.json(body));
      await harness.render(<StatusPage />);
      await settle(() => expect(harness.host.textContent).toContain('mongodb'));
      expect(region('mTLS DNS admission fence')).toBeNull();
      expect(harness.host.textContent).not.toContain('Operational diagnostics need attention');
    },
  );

  it('renders nothing for a gateway that omits the fence (Edge v0.9.20)', async () => {
    stubFetch(() => Response.json({ ...detailedHealth, database: { status: 'connected', type: 'sqlite' } }));
    await harness.render(<StatusPage />);
    await settle(() => expect(harness.host.textContent).toContain('sqlite'));
    expect(region('mTLS DNS admission fence')).toBeNull();
    expect(harness.host.textContent).not.toContain('Operational diagnostics need attention');
  });
});
