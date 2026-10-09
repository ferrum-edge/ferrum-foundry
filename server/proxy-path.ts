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

// Namespace-scoped principals may use the explicitly known resource route
// classes below, mirroring Edge's `namespace_scoped_resource_kind`. Edge does
// not apply the namespace claim to its other admin routes, so anything not
// classified here or in the global ceiling is denied by default. `POST /batch`,
// `GET /backup`, and `POST /restore` take their namespace from the header.
const NAMESPACE_SCOPED_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'GET|POST',
    /^\/(proxies|upstreams|consumers|plugins\/config|api-specs|gateway-trust-bundles)\/?$/,
  ],
  [
    'GET|PUT|DELETE',
    /^\/(proxies|upstreams|consumers|plugins\/config|api-specs|gateway-trust-bundles)\/[^/]+\/?$/,
  ],
  // Edge serves PUT (replace), POST (append), and DELETE (remove all) on a
  // credential type, and only DELETE on one indexed credential.
  ['POST|PUT|DELETE', /^\/consumers\/[^/]+\/credentials\/[^/]+\/?$/],
  ['DELETE', /^\/consumers\/[^/]+\/credentials\/[^/]+\/[^/]+\/?$/],
  ['GET', /^\/api-specs\/by-proxy\/[^/]+\/?$/],
  ['GET', /^\/proxies\/[^/]+\/mcp\/tools\/?$/],
  ['GET', /^\/gateway-trust\/status\/?$/],
  ['GET', /^\/config\/export\/?$/],
  ['GET', /^\/audit\/?$/],
  ['GET', /^\/backend-egress-policy\/?$/],
  ['POST', /^\/(batch|restore)\/?$/],
  ['GET', /^\/backup\/?$/],
];

// Fleet-wide route classes a namespace-scoped principal may reach without a
// granted namespace header. Keep methods and paths explicit so newly added
// admin routes default-deny.
// - `GET /plugins`, `GET /namespaces*`, `/live`, `/health`, and `/status` are
//   Edge's own ceiling. Foundry signs with the primary key, which Edge treats as
//   detail-authorized, so the proxy projects `/health` and `/status` down to
//   their summary fields for a scoped principal; `/overload` stays withheld.
// - Edge allows only GET on `/namespaces*`. The registry writes here are safe
//   only because `namespace-registry.ts` confines both the path and the body
//   names to the principal's grants.
// - `GET /config/apply-status` is process-topology in Edge: it ignores the
//   namespace header and reveals only the apply cursor. The UI polls it
//   without a header after a fleet-wide write.
const NAMESPACE_SAFE_GLOBAL_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/plugins$/],
  ['GET|POST', /^\/namespaces$/],
  ['GET|PUT|DELETE', /^\/namespaces\/[^/]+$/],
  ['GET', /^\/(live|health|status)$/],
  ['GET', /^\/config\/apply-status\/?$/],
];

// A namespace-scoped principal may read and validate fleet TLS material but may
// not create, replace, rotate, renew, finalize, or delete it: each of those
// changes fleet-wide state that the namespace claim does not scope. Edge's own
// ceiling denies `/admin/tls/*` to tenant-bounded callers.
const FLEET_GLOBAL_SCOPED_DENIED_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST|PUT|DELETE', /^\/admin\/tls\/(?!validate$)/],
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

/** Credential-complete reconciliation reads must never reach a browser. */
export function proxyPathIsConsumerVerification(path: string): boolean {
  // Consume proxyTargetPath's serialized pathname, exactly as proxyTargetUrl
  // forwards it. IDs may still contain URL escapes; never decode it again.
  return /^\/consumers\/[^/]+\/verification\/?$/.test(path);
}

/** Deployment evidence includes original credentials and is not a browser read. */
export function proxyPathIsDeploymentSnapshot(path: string): boolean {
  // Classify only the normalized pathname serialized for upstream fetch.
  return path === '/deployment-snapshot' || path === '/deployment-snapshot/';
}

export function requestIsProxyRoute(request: FastifyRequest): boolean {
  const routePath = request.routeOptions.url ?? '';
  return routePath === '/api/proxy/*' || routePath.startsWith(PROXY_PREFIX);
}

/**
 * Whether an unmatched request may be answered with the SPA shell. Only a
 * page navigation can be: a write to a page path is not one, and a missing
 * build asset is a stale chunk from an earlier deploy, which a 404 reports
 * plainly where `index.html` fails as an opaque MIME-type error.
 */
export function servesSpaShell(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (requestIsApiRoute(request)) return false;
  const requestPath = request.url.split('?', 1)[0];
  return requestPath !== '/api' && !requestPath.startsWith('/assets/');
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

// The BFF and Edge answer HEAD exactly like GET, so a route class that allows
// GET also allows HEAD.
function classifiedMethod(request: FastifyRequest): string {
  return request.method === 'HEAD' ? 'GET' : request.method;
}

export function proxyPathIsFleetGlobal(request: FastifyRequest): boolean {
  try {
    const path = proxyTargetPath(request);
    const method = classifiedMethod(request);
    return FLEET_GLOBAL_ROUTES.some(([methods, pattern]) => methods.split('|').includes(method) && pattern.test(path));
  } catch {
    return false;
  }
}

/** Whether a namespace-scoped principal may reach this known Edge route class. */
export function proxyPathIsAllowedForNamespace(request: FastifyRequest): boolean {
  try {
    const path = proxyTargetPath(request);
    const method = classifiedMethod(request);
    const routeAllowed = ([methods, pattern]: readonly [string, RegExp]) =>
      methods.split('|').includes(method) && pattern.test(path);
    if (FLEET_GLOBAL_SCOPED_DENIED_ROUTES.some(routeAllowed)) return false;
    return FLEET_GLOBAL_ROUTES.some(routeAllowed)
      || NAMESPACE_SAFE_GLOBAL_ROUTES.some(routeAllowed)
      || NAMESPACE_SCOPED_ROUTES.some(routeAllowed);
  } catch {
    return false;
  }
}

export function proxyPathIsEdgeNamespaceSafeGlobal(request: FastifyRequest): boolean {
  try {
    const path = proxyTargetPath(request);
    const method = classifiedMethod(request);
    return NAMESPACE_SAFE_GLOBAL_ROUTES.some(([methods, pattern]) =>
      methods.split('|').includes(method) && pattern.test(path));
  } catch {
    return false;
  }
}
