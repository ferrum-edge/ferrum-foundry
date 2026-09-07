import type { FastifyRequest } from 'fastify';

const MAX_DECODE_PASSES = 8;
const PROXY_PREFIX = '/api/proxy/';
const targetPaths = new WeakMap<FastifyRequest, string>();

// Keep in sync with upstream src/admin/mod.rs and openapi.yaml. New TLS
// operations require an explicit exemption, never a namespace-free prefix.
const FLEET_GLOBAL_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/admin\/tls\/(inventory|events)$/],
  ['GET|POST', /^\/admin\/tls\/(certificates|ca-bundles|crls|ocsp-responses|jwks)$/],
  ['GET|PUT|DELETE', /^\/admin\/tls\/(certificates|ca-bundles|crls|ocsp-responses|jwks)\/[^/]+$/],
  ['GET|POST', /^\/admin\/tls\/acme\/(certificates|orders)$/],
  ['GET|PUT|DELETE', /^\/admin\/tls\/acme\/certificates\/[^/]+$/],
  ['GET|DELETE', /^\/admin\/tls\/acme\/orders\/[^/]+$/],
  ['GET', /^\/admin\/tls\/acme\/accounts$/],
  ['POST', /^\/admin\/tls\/acme\/orders\/[^/]+\/finalize$/],
  ['POST', /^\/admin\/tls\/acme\/renew\/[^/]+$/],
  ['POST', /^\/admin\/tls\/rotate\/[^/]+$/],
  ['POST', /^\/admin\/tls\/validate$/],
];

export class UnsafeProxyPathError extends Error {
  constructor() {
    super('Proxy path is unsafe');
    this.name = 'UnsafeProxyPathError';
  }
}

function containsControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

export function proxyTargetPath(request: FastifyRequest): string {
  const cached = targetPaths.get(request);
  if (cached !== undefined) return cached;

  // Fastify has already decoded wildcard parameters. Start with the raw
  // request target instead, so an encoded separator cannot become structure
  // and a valid escaped identifier is decoded exactly once on every route.
  const rawPath = (request.raw.url ?? request.url).split('?', 1)[0];
  if (!rawPath.startsWith('/') || containsControl(rawPath) || rawPath.includes('#')) {
    throw new UnsafeProxyPathError();
  }
  const segments = rawPath.split('/').slice(1).map((encoded) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new UnsafeProxyPathError();
    }
    // No recursive decoding: a remaining percent sign is ambiguous to later
    // parsers. Reject separators, controls and dot segments before URL can
    // remove or reinterpret any of them. Ordinary dots inside IDs are valid.
    if (containsControl(decoded) || /[%/\\]/.test(decoded) || decoded === '.' || decoded === '..') {
      throw new UnsafeProxyPathError();
    }
    return decoded;
  });
  if (segments[0] !== 'api' || segments[1] !== 'proxy' || segments.length < 3) {
    throw new UnsafeProxyPathError();
  }
  const pathSegments = segments.slice(2);
  // Preserve the root and a single trailing slash, but never collapse a
  // repeated separator into a different endpoint.
  if (pathSegments.slice(0, -1).some((segment) => segment === '')) throw new UnsafeProxyPathError();
  const target = new URL('http://proxy.invalid');
  target.pathname = `/${pathSegments.join('/')}`;
  const path = target.pathname;
  targetPaths.set(request, path);
  return path;
}

export function proxyTargetUrl(request: FastifyRequest, adminUrl: string): URL {
  const path = proxyTargetPath(request);
  const target = new URL(adminUrl);
  target.pathname = path;
  const rawUrl = request.raw.url ?? request.url;
  const queryIndex = rawUrl.indexOf('?');
  target.search = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
  target.hash = '';
  // Every classifier consumes precisely the pathname serialized for fetch.
  if (target.pathname !== path) throw new UnsafeProxyPathError();
  return target;
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
    const path = proxyTargetPath(request);
    return FLEET_GLOBAL_ROUTES.some(([methods, pattern]) => methods.split('|').includes(request.method) && pattern.test(path));
  } catch {
    return false;
  }
}
