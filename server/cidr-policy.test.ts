import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { Agent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  lookup: vi.fn(),
  lookups: [] as LookupFunction[],
}));

vi.mock('node:dns', () => ({ lookup: transport.lookup }));
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    Agent: class extends original.Agent {
      constructor(options: Agent.Options) {
        super(options);
        if (typeof options.connect === 'object' && options.connect.lookup) {
          transport.lookups.push(options.connect.lookup);
        }
      }
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  transport.lookup.mockReset();
  transport.lookups.length = 0;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FERRUM_')) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test',
    FERRUM_AUTH_MODE: 'static',
    FERRUM_ADMIN_URL: 'https://initial.example',
    FERRUM_JWT_SECRET: 'cidr-signing-fixture-at-least-32-characters',
    FERRUM_BFF_AUTH_TOKEN: 'cidr-login-fixture-at-least-32-characters',
    FERRUM_ALLOW_RUNTIME_SETTINGS: 'true',
    FERRUM_ADMIN_ALLOWED_ORIGINS: 'https://runtime.example',
  })) vi.stubEnv(key, value);
});

afterEach(async () => {
  await (await import('./tls.js')).closeDispatchers();
  vi.unstubAllEnvs();
});

// Exercise the lookup actually installed by the dispatcher, with controlled
// DNS answers and no socket or external DNS traffic.
async function lookupResult(addresses: LookupAddress[], hostname = 'runtime.example'): Promise<NodeJS.ErrnoException | null> {
  transport.lookup.mockImplementationOnce((_hostname, _options, callback) => callback(null, addresses));
  const lookup = transport.lookups.at(-1);
  expect(lookup).toBeDefined();
  return new Promise((resolve) => {
    lookup!(hostname, { all: true }, (error) => resolve(error));
  });
}

const malformed = [
  '10.20.30.40', '10.20.30.40/', '10.20.30.40/ ', '10.20.30.40/\t',
  '10.20.30.40/-1', '10.20.30.40/-0', '10.20.30.40/+0', '10.20.30.40/1.5',
  '10.20.30.40/1e1', '10.20.30.40/0x10', '10.20.30.40/0b10', '10.20.30.40/0o10',
  '10.20.30.40/NaN', '10.20.30.40/Infinity', '10.20.30.40/0/0', '10.20.30.40/32/',
  '10.20.30.40/33', '10.20.30.40/00', '10.20.30.40/032', '10.20.30.40/ 0',
  '10.20.30.40/3 2', '10.20.30.40/３２', '10.20.30.40 /32', '999.0.0.1/8',
  'gateway.example/24', '/0',
  'fd00::1', 'fd00::1/', 'fd00::1/\n', 'fd00::1/-1', 'fd00::1/0.0',
  'fd00::1/0x80', 'fd00::1/129', 'fd00::1/00', 'fd00::1/0128', 'fd00::1/0/0',
];

describe('shared configuration and dispatcher CIDR policy', () => {
  it.each(malformed)('rejects malformed CIDR %j in the loader and enforcement', async (cidr) => {
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', cidr);
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow(/FERRUM_ADMIN_ALLOWED_CIDRS/);

    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', undefined);
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_ORIGINS', 'http://192.168.99.99');
    await updateRuntimeConfig({ adminUrl: 'http://192.168.99.99' });
    const { getDispatcher } = await import('./tls.js');
    expect(() => getDispatcher({ ...loadConfig(), adminAllowedCidrs: [cidr] }))
      .toThrow(/FERRUM_ADMIN_ALLOWED_CIDRS/);
  });

  it.each([
    ['10.20.30.40', 32], ['fd00::1', 128],
  ] as const)('accepts every explicit prefix in the %s address family', async (address, maximum) => {
    const cidrs = Array.from({ length: maximum + 1 }, (_, prefix) => `${address}/${prefix}`);
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', ` ${cidrs.join(', ')} `);
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    expect(loadConfig().adminAllowedCidrs).toEqual(cidrs);
    await updateRuntimeConfig({ adminUrl: 'https://runtime.example' });
    const { getDispatcher } = await import('./tls.js');
    getDispatcher(loadConfig());
    expect(await lookupResult([{ address, family: maximum === 32 ? 4 : 6 }])).toBeNull();
  });

  it.each([
    { cidr: '10.20.30.40/0', address: '192.168.99.99', family: 4, allowed: true },
    { cidr: 'fd00::1/0', address: 'fe80::1234', family: 6, allowed: true },
    { cidr: '10.20.30.40/32', address: '10.20.30.40', family: 4, allowed: true },
    { cidr: '10.20.30.40/32', address: '10.20.30.41', family: 4, allowed: false },
    { cidr: 'fd00::1/128', address: 'fd00::1', family: 6, allowed: true },
    { cidr: 'fd00::1/128', address: 'fd00::2', family: 6, allowed: false },
    { cidr: '10.20.30.0/24', address: '10.20.30.255', family: 4, allowed: true },
    { cidr: '10.20.30.0/24', address: '10.20.31.0', family: 4, allowed: false },
    { cidr: 'fd00::/64', address: 'fd00::ffff', family: 6, allowed: true },
    { cidr: 'fd00::/64', address: 'fd00:0:0:1::', family: 6, allowed: false },
    { cidr: '', address: '192.168.99.99', family: 4, allowed: false },
    { cidr: '', address: 'fd00::1', family: 6, allowed: false },
    { cidr: '', address: '8.8.8.8', family: 4, allowed: true },
  ])('enforces $cidr for literal and DNS address $address: $allowed', async ({ cidr, address, family, allowed }) => {
    const origin = `http://${family === 6 ? `[${address}]` : address}`;
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', cidr);
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_ORIGINS', `${origin},https://runtime.example`);
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    const { getDispatcher } = await import('./tls.js');
    await updateRuntimeConfig({ adminUrl: origin });
    if (allowed) expect(() => getDispatcher(loadConfig())).not.toThrow();
    else expect(() => getDispatcher(loadConfig())).toThrow(/network policy/);

    await updateRuntimeConfig({ adminUrl: 'https://runtime.example' });
    getDispatcher(loadConfig());
    const error = await lookupResult([{ address, family }]);
    if (allowed) expect(error).toBeNull();
    else expect(error?.code).toBe('EACCES');
  });

  it('rejects a mixed DNS answer when any address is outside policy', async () => {
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', '10.20.30.40/32');
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    await updateRuntimeConfig({ adminUrl: 'https://runtime.example' });
    (await import('./tls.js')).getDispatcher(loadConfig());
    expect((await lookupResult([
      { address: '10.20.30.40', family: 4 }, { address: 'fd00::1', family: 6 },
    ]))?.code).toBe('EACCES');
  });

  it('keeps the origin allowlist independent of explicit all-address CIDRs', async () => {
    vi.stubEnv('FERRUM_ADMIN_ALLOWED_CIDRS', '0.0.0.0/0,::/0');
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    await expect(updateRuntimeConfig({ adminUrl: 'http://192.168.99.99' }))
      .rejects.toThrow(/FERRUM_ADMIN_ALLOWED_ORIGINS/);
    expect(loadConfig().adminUrl).toBe('https://initial.example');
  });

  it.each(['http://192.168.99.99', 'https://initial.example'])('retains the initial-origin exemption for %s', async (origin) => {
    vi.stubEnv('FERRUM_ADMIN_URL', origin);
    const { loadConfig, updateRuntimeConfig } = await import('./config.js');
    const { getDispatcher } = await import('./tls.js');
    await updateRuntimeConfig({ adminUrl: 'https://runtime.example' });
    await updateRuntimeConfig({ adminUrl: origin });
    expect(() => getDispatcher(loadConfig())).not.toThrow();
    expect(await lookupResult([{ address: '192.168.99.99', family: 4 }], new URL(origin).hostname)).toBeNull();
  });
});
