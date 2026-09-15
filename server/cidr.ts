import { isIP } from 'node:net';

/** Parse the same explicit CIDR syntax at configuration and enforcement time. */
export function parseCidr(value: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [address, rawPrefix, ...extra] = value.trim().split('/');
  const family = isIP(address);
  // Only canonical decimal prefixes: no signs, leading zeros, whitespace,
  // exponent notation or radix prefixes. Explicit /0 remains intentional.
  if (
    extra.length !== 0
    || family === 0
    || rawPrefix === undefined
    || !/^(0|[1-9][0-9]{0,2})$/.test(rawPrefix)
  ) {
    throw new Error('FERRUM_ADMIN_ALLOWED_CIDRS contains an invalid CIDR');
  }
  const prefix = Number(rawPrefix);
  if (prefix > (family === 4 ? 32 : 128)) {
    throw new Error('FERRUM_ADMIN_ALLOWED_CIDRS contains an invalid CIDR');
  }
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}
