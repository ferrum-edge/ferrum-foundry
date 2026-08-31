import type { FastifyRequest } from 'fastify';

const MAX_DECODE_PASSES = 8;
const PROXY_PREFIX = '/api/proxy/';

export class UnsafeProxyPathError extends Error {
  constructor() {
    super('Proxy path contains an unsafe dot segment');
    this.name = 'UnsafeProxyPathError';
  }
}

function containsDotSegment(value: string): boolean {
  let candidate = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (candidate.replaceAll('\\', '/').split('/').some((segment) => segment === '.' || segment === '..')) {
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }

  // Deeply nested encodings are not valid resource identifiers and can be
  // decoded a different number of times by intermediaries.
  return true;
}

export function proxyTargetPath(request: FastifyRequest): string {
  const wildcard = (request.params as Record<string, unknown>)['*'];
  let value: string;
  if (typeof wildcard === 'string') {
    value = wildcard;
  } else {
    const requestPath = request.url.split('?', 1)[0];
    const encoded = requestPath.startsWith(PROXY_PREFIX) ? requestPath.slice(PROXY_PREFIX.length) : '';
    try {
      value = decodeURIComponent(encoded);
    } catch {
      throw new UnsafeProxyPathError();
    }
  }
  value = value.replace(/^\/+/, '');
  if (containsDotSegment(value)) throw new UnsafeProxyPathError();
  return `/${value}`;
}

export function proxyPathIsFleetGlobal(request: FastifyRequest): boolean {
  try {
    return proxyTargetPath(request).startsWith('/admin/tls/');
  } catch {
    return false;
  }
}
