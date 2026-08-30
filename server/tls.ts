import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { loadCaBundle } from './ca.js';
import { registerRuntimeConfigListener, type Config } from './config.js';

interface ManagedDispatcher {
  fingerprint: string;
  agent: Agent;
}

const blockedNetworks = new BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
] as const) {
  blockedNetworks.addSubnet(address, prefix, family);
}

let activeDispatcher: ManagedDispatcher | undefined;

function parseAllowedCidrs(values: string[]): BlockList {
  const list = new BlockList();
  for (const value of values) {
    const [address, rawPrefix, ...extra] = value.split('/');
    const ipFamily = isIP(address);
    const prefix = Number(rawPrefix);
    const maxPrefix = ipFamily === 4 ? 32 : 128;
    if (extra.length > 0 || ipFamily === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error('FERRUM_ADMIN_ALLOWED_CIDRS contains an invalid CIDR');
    }
    list.addSubnet(address, prefix, ipFamily === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

function addressIsAllowed(address: string, family: number, config: Config): boolean {
  const type = family === 6 ? 'ipv6' : 'ipv4';
  const targetIsTrustedEnvironmentOrigin = config.adminUrl === config.initialAdminOrigin;
  if (targetIsTrustedEnvironmentOrigin) return true;

  const explicitlyAllowed = parseAllowedCidrs(config.adminAllowedCidrs);
  if (explicitlyAllowed.check(address, type)) return true;
  return !blockedNetworks.check(address, type);
}

function assertLiteralAddressAllowed(config: Config): void {
  const address = new URL(config.adminUrl).hostname.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family !== 0 && !addressIsAllowed(address, family, config)) {
    throw new Error('Configured gateway address is outside the permitted network policy');
  }
}

function secureLookup(config: Config): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options as LookupOptions, (
      error: NodeJS.ErrnoException | null,
      result: string | LookupAddress[],
      family?: number,
    ) => {
      if (error) return callback(error, result, family);
      const addresses = Array.isArray(result)
        ? result
        : [{ address: result, family: family ?? isIP(result) }];
      if (addresses.some((entry) => !addressIsAllowed(entry.address, entry.family, config))) {
        const denied = new Error('Gateway DNS result is outside the permitted network policy') as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        return callback(denied, result, family);
      }
      return callback(null, result, family);
    });
  };
}

function dispatcherFingerprint(config: Config): string {
  return JSON.stringify({
    origin: config.adminUrl,
    connectTimeout: config.connectTimeout,
    readTimeout: config.readTimeout,
    tlsVerify: config.tlsVerify,
    caPath: config.tlsCaPath,
    cidrs: config.adminAllowedCidrs,
  });
}

function createDispatcher(config: Config, fingerprint: string): ManagedDispatcher {
  assertLiteralAddressAllowed(config);
  const isHttps = config.adminUrl.startsWith('https://');
  const caBundle = isHttps && config.tlsCaPath
    ? loadCaBundle(config.tlsCaPath, config.tlsCaRoot)
    : undefined;
  const agent = new Agent({
    connect: {
      timeout: config.connectTimeout,
      lookup: secureLookup(config),
      ...(isHttps && {
        rejectUnauthorized: config.tlsVerify,
        ...(caBundle && { ca: caBundle.pem }),
      }),
    },
    headersTimeout: Math.max(config.readTimeout, 120_000),
    bodyTimeout: config.readTimeout,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
  return { fingerprint, agent };
}

export function getDispatcher(config: Config): Agent {
  const fingerprint = dispatcherFingerprint(config);
  if (activeDispatcher?.fingerprint === fingerprint) return activeDispatcher.agent;

  const retired = activeDispatcher;
  activeDispatcher = createDispatcher(config, fingerprint);
  if (retired) void retired.agent.close().catch(() => undefined);
  return activeDispatcher.agent;
}

export async function closeDispatchers(): Promise<void> {
  const dispatcher = activeDispatcher;
  activeDispatcher = undefined;
  if (dispatcher) await dispatcher.agent.close();
}

registerRuntimeConfigListener(closeDispatchers);
