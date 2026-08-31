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
    const routePath = request.routeOptions.url ?? '';
    const requestPath = request.url.split('?', 1)[0];
    const encoded = routePath.startsWith(PROXY_PREFIX)
      ? routePath.slice(PROXY_PREFIX.length)
      : requestPath.startsWith(PROXY_PREFIX) ? requestPath.slice(PROXY_PREFIX.length) : '';
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

export function requestIsProxyRoute(request: FastifyRequest): boolean {
  const routePath = request.routeOptions.url ?? '';
  return routePath === '/api/proxy/*' || routePath.startsWith(PROXY_PREFIX);
}

export function requestIsApiRoute(request: FastifyRequest): boolean {
  if (request.routeOptions.url?.startsWith('/api/')) return true;

  let requestPath = request.url.split('?', 1)[0];
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (requestPath.startsWith('/api/')) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return false;
    }
    if (decoded === requestPath) return false;
    requestPath = decoded;
  }
  return true;
}

export function proxyPathIsFleetGlobal(request: FastifyRequest): boolean {
  try {
    return proxyTargetPath(request).startsWith('/admin/tls/');
  } catch {
    return false;
  }
}
