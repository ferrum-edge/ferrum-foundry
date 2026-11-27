import type { FastifyRequest } from 'fastify';

const UNSAFE_SEGMENT_CHARACTER_PATTERN = /[%/\\]/;
const CONSUMER_VERIFICATION_PATH_PATTERN = /^\/consumers\/[^/]+\/verification\/?$/;

const LEADING_SLASHES_PATTERN = /^\/+/;
const MAX_DECODE_PASSES = 8;
const PROXY_PREFIX = '/api/proxy/';
const targetPaths = new WeakMap<FastifyRequest, string>();

// Namespace-scoped principals may use the explicitly known resource route
// classes below, mirroring Edge's `namespace_scoped_resource_kind`, and the
// global allowlist after them. Anything else is denied by default, matching
// Edge v0.9.16+ (`ns_claim_global_route_is_allowed`, ferrum-edge#6093), which
// refuses every other route to an admin JWT carrying an `ns` claim. Earlier
// Edge releases admit such a JWT on fleet-global routes, so the BFF is the only
// ceiling there. `GET /backup` and `POST /restore` take their namespace from
// the header.
//
// Least privilege: Edge also classifies `GET /config/export`,
// `GET /backend-egress-policy`, and `POST /batch` as namespace-scoped, but
// Foundry uses none of them, so they are not listed and a scoped principal is
// refused (docs/admin-api-coverage.md). An unrestricted session is not subject
// to this ceiling.
export const NAMESPACE_SCOPED_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
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
  ['GET', /^\/audit\/?$/],
  ['POST', /^\/restore\/?$/],
  ['GET', /^\/backup\/?$/],
];

/**
 * Where `EDGE_NAMESPACE_SCOPED_KINDS` and the allowlist digest were read.
 * `npm run check:edge-source-parity` (`scripts/edge-source-parity.mjs`) re-reads
 * `path` at `edge.source_commit` in the Pinned Gateway Contract job, and at
 * Edge `main` in the Edge Main Drift workflow, and fails when Edge's match
 * arms differ from the table, when the complete
 * `namespace_scoped_resource_kind` and `is_namespace_scoped_route` and the
 * bodies of `ceiling_global_route_is_allowed` and
 * `ns_claim_global_route_is_allowed` no longer hash to `allowlistDigest`
 * (comments removed, whitespace collapsed),
 * or when `commit` is not the checked commit.
 */
export const EDGE_NAMESPACE_ROUTE_SOURCE = {
  repository: 'ferrum-edge/ferrum-edge',
  path: 'src/admin/mod.rs',
  release: 'v0.9.21',
  commit: 'f9915358c8032214f4034a17c28cdf72d14006c3',
  // The classifier whole (not only its match arms, so an early return or a
  // changed result fails too), its wrapper, and the two `ns`-claim allowlists.
  allowlistFunctions: [
    'namespace_scoped_resource_kind',
    'is_namespace_scoped_route',
    'ceiling_global_route_is_allowed',
    'ns_claim_global_route_is_allowed',
  ],
  allowlistDigest: '3ace92f83d7a9ba34b4936a7b264ed2750e309b4b37b04080b93225356a3abb2',
} as const;

/** Each match guard Edge uses, as Rust text without whitespace, and what it tests. */
const EDGE_KIND_GUARDS = {
  'segments.len()==1': (segments: readonly string[]) => segments.length === 1,
  'segments.len()>1': (segments: readonly string[]) => segments.length > 1,
  'segments.get(1)==Some(&"export")': (segments: readonly string[]) => segments[1] === 'export',
} as const;

export interface EdgeNamespaceScopedKind {
  /** The first path segment Edge matches. */
  segment: string;
  /** The arm's `if` guard as Rust text without whitespace, or null. */
  guard: keyof typeof EDGE_KIND_GUARDS | null;
  /** The resource-kind label Edge returns. */
  kind: string;
  /** Whether the BFF lets a namespace-scoped principal reach this route class. */
  exposed: boolean;
}

/**
 * Edge's `namespace_scoped_resource_kind`, arm by arm in match order: the
 * routes where `X-Ferrum-Namespace` selects a tenant, so Edge authorizes an
 * `ns`-claim token by name instead of refusing it as fleet-global. A scoped
 * request reaches Edge only when its route class is `exposed` here *and*
 * `NAMESPACE_SCOPED_ROUTES` lists the exact method and path, so a kind Edge
 * stops classifying as namespace-scoped is refused as soon as this table
 * follows it. Withheld (least privilege, docs/admin-api-coverage.md): `/batch`,
 * `/deployment-snapshot` (refused to every session), `/backend-egress-policy`
 * and `/config/export`.
 */
export const EDGE_NAMESPACE_SCOPED_KINDS: readonly EdgeNamespaceScopedKind[] = [
  { segment: 'proxies', guard: null, kind: 'proxies', exposed: true },
  { segment: 'consumers', guard: null, kind: 'consumers', exposed: true },
  { segment: 'upstreams', guard: null, kind: 'upstreams', exposed: true },
  { segment: 'api-specs', guard: null, kind: 'api-specs', exposed: true },
  { segment: 'batch', guard: null, kind: 'batch', exposed: false },
  { segment: 'backup', guard: null, kind: 'backup', exposed: true },
  { segment: 'deployment-snapshot', guard: null, kind: 'deployment-snapshot', exposed: false },
  { segment: 'backend-egress-policy', guard: 'segments.len()==1', kind: 'backend-egress-policy', exposed: false },
  { segment: 'config', guard: 'segments.get(1)==Some(&"export")', kind: 'config-export', exposed: false },
  { segment: 'restore', guard: null, kind: 'restore', exposed: true },
  { segment: 'audit', guard: null, kind: 'audit', exposed: true },
  { segment: 'gateway-trust-bundles', guard: null, kind: 'gateway-trust-bundles', exposed: true },
  { segment: 'gateway-trust', guard: null, kind: 'gateway-trust', exposed: true },
  { segment: 'plugins', guard: 'segments.len()>1', kind: 'plugins', exposed: true },
];

/**
 * The arm of Edge's `namespace_scoped_resource_kind` that classifies `path`,
 * or undefined when Edge treats it as fleet-global. Segments are split as Edge
 * splits them (`path.trim_start_matches('/').split('/')`), so a trailing slash
 * is an empty last segment.
 */
export function edgeNamespaceScopedKind(path: string): EdgeNamespaceScopedKind | undefined {
  const segments = path.replace(LEADING_SLASHES_PATTERN, '').split('/');
  return EDGE_NAMESPACE_SCOPED_KINDS.find((arm) =>
    arm.segment === segments[0] && (arm.guard === null || EDGE_KIND_GUARDS[arm.guard](segments)));
}

// Fleet-wide route classes a namespace-scoped principal may reach without a
// granted namespace header: Edge's `ns`-claim allowlist, less the routes the
// BFF withholds. Keep methods and paths explicit so newly added admin routes
// default-deny.
// - `GET /plugins`, `GET /namespaces*`, `/live`, `/health`, and `/status` are
//   Edge's own ceiling. The proxy projects `/health` and `/status` down to the
//   summary fields of `projectHealthSummary` for a scoped principal, whichever
//   tier Edge answers. `/overload` stays withheld.
// - `POST /namespaces` and `PUT`/`DELETE /namespaces/{name}` are allowed by
//   Edge because its registry handlers authorize the claim themselves; the BFF
//   also confines the path and body names to the principal's grants
//   (`namespace-registry.ts`).
// - Edge's `GET /diagnostics/v1/refs/{ref}` stays denied here: Foundry
//   resolves references only through its dedicated
//   `GET /api/diagnostics/lookup` route (`routes/diagnostics.ts`), which signs a
//   per-lookup, namespace-bound token with the `diagnostics:read` scope.
// - Everything else is fleet-global and refused: TLS inventory, material, ACME,
//   rotation and validation; `/cluster`; `/config/apply-status`; `/metrics*`
//   and `/admin/metrics`; `/charges*`; `/backend-capabilities*`; `/mesh/*`; and
//   the waypoint routes.
export const NAMESPACE_SAFE_GLOBAL_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/plugins$/],
  ['GET|POST', /^\/namespaces$/],
  ['GET|PUT|DELETE', /^\/namespaces\/[^/]+$/],
  ['GET', /^\/(live|health|status)$/],
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
    if (containsControl(decoded) || UNSAFE_SEGMENT_CHARACTER_PATTERN.test(decoded) || decoded === '.' || decoded === '..') {
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
  return CONSUMER_VERIFICATION_PATH_PATTERN.test(path);
}

/** Deployment evidence includes original credentials and is not a browser read. */
export function proxyPathIsDeploymentSnapshot(path: string): boolean {
  // Classify only the normalized pathname serialized for upstream fetch.
  return path === '/deployment-snapshot' || path === '/deployment-snapshot/';
}

/**
 * Clearing a mesh data plane's accepted config revision lowers a fail-closed
 * rollback guard. Foundry deliberately does not expose that break-glass
 * operation, so no session may send it through the BFF, whatever its role.
 */
export function proxyPathIsMeshConfigRevisionReset(path: string): boolean {
  // Classify only the normalized pathname serialized for upstream fetch.
  return path === '/mesh/config-revision/reset' || path === '/mesh/config-revision/reset/';
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

// A route class that allows GET also allows HEAD. Edge has no HEAD routes of
// its own: only its early `/live`, `/health`, and `/status` branches ignore the
// method, it answers HEAD elsewhere with 404 or 405, and v0.9.16 refuses a
// scoped `HEAD /plugins` (its `ns`-claim allowlist is GET-exact). Edge is
// therefore never less strict than this ceiling.
function classifiedMethod(request: FastifyRequest): string {
  return request.method === 'HEAD' ? 'GET' : request.method;
}

/** Whether a namespace-scoped principal may reach this known Edge route class. */
export function proxyPathIsAllowedForNamespace(request: FastifyRequest): boolean {
  try {
    const path = proxyTargetPath(request);
    const method = classifiedMethod(request);
    const routeAllowed = ([methods, pattern]: readonly [string, RegExp]) =>
      methods.split('|').includes(method) && pattern.test(path);
    if (NAMESPACE_SAFE_GLOBAL_ROUTES.some(routeAllowed)) return true;
    return NAMESPACE_SCOPED_ROUTES.some(routeAllowed) && edgeNamespaceScopedKind(path)?.exposed === true;
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
