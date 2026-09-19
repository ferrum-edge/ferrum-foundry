import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, settle, stubFetch } from '@/test/__tests__/harness';
import { adverseHealth, detailedHealth, logSink } from '@/test/__tests__/healthFixtures';
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
    await settle(() => expect(harness.host.textContent).toContain('Failed to fetch health status'));
    expect(harness.host.textContent).not.toContain('Collection disabled');
    expect(harness.host.textContent).not.toContain('Ready');
  });
});
