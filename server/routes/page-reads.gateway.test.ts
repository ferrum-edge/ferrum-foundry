import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { isGatewayHealthSnapshot } from '../../shared/health-snapshot.js';
import { adminMetricsReporting } from '../../src/lib/adminMetricsReporting.js';
import { isAddressableResourceId } from '../../src/lib/resourceId.js';

/**
 * Every read a Foundry page makes, sent through the BFF against a gateway in
 * one mode, with the fields the page consumes checked on each answer.
 *
 * A read answers `200` with that contract in every mode except where this
 * job's fixture leaves its feature off; there it must give exactly the
 * recorded `404`/`503` (`absent`). Losing a read the fixture enables, or a
 * changed answer where it is off, fails. Detail reads open the first row of
 * each collection the way the editors do, and the fixture's own proxy must be
 * listed where the job created one.
 */
type Mode = 'file' | 'cp' | 'dp' | 'mesh' | 'database';

interface PageRead {
  page: string;
  path: string;
  /** Prometheus text, not JSON. */
  text?: true;
  /**
   * Sent by a namespace-scoped session. With Edge's
   * FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM an unrestricted session cannot use
   * namespace routes, and a scoped one cannot use fleet routes, so an
   * operator uses one identity per kind (docs/authentication.md).
   */
  scoped?: true;
  /** The exact status in each mode whose fixture leaves the feature off. */
  absent?: Partial<Record<Mode, 404 | 503>>;
  /** The fields the page reads from a `200`; a message when one is wrong. */
  check: (body: unknown) => string | null;
}

const WHITESPACE_RUNS_PATTERN = /\s+/g;
const PIPE_PATTERN = /\|/g;
const BACKSLASH_PATTERN = /\\/g;
const PROMETHEUS_TYPE_PATTERN = /^# TYPE /m;

/** `text` as one Markdown table cell: backslashes first, then pipes. */
function tableCell(text: string): string {
  return text.replace(BACKSLASH_PATTERN, '\\\\').replace(PIPE_PATTERN, '\\|');
}

type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'number|null' | 'object|null';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A check that each dotted path holds a value of its kind. */
function fields(spec: Record<string, Kind>): (body: unknown) => string | null {
  return (body) => {
    const wrong: string[] = [];
    for (const [path, kind] of Object.entries(spec)) {
      let value: unknown = body;
      for (const key of path.split('.')) value = isObject(value) ? value[key] : undefined;
      if (!kind.split('|').includes(kindOf(value))) wrong.push(`${path} is ${kindOf(value)}, not ${kind}`);
    }
    return wrong.length > 0 ? wrong.join('; ') : null;
  };
}

const paginated = fields({
  data: 'array', 'pagination.offset': 'number', 'pagination.limit': 'number', 'pagination.total': 'number',
});
const itemPage = fields({
  items: 'array', limit: 'number', offset: 'number', next_offset: 'number|null', total: 'number',
});

/** The feature is off in every mode this job runs. */
const NEVER: Partial<Record<Mode, 404>> = { file: 404, cp: 404, dp: 404, mesh: 404, database: 404 };
/** Mesh observability: served by the mesh sidecar only. */
const MESH_ONLY: Partial<Record<Mode, 404>> = { file: 404, cp: 404, dp: 404, database: 404 };
/** Features that need a configuration database (API specs, audit, trust). */
const DATABASE_BACKED: Partial<Record<Mode, 503>> = { file: 503, dp: 503, mesh: 503 };

const PAGE = '?offset=0&limit=50';
const PAGE_READS: PageRead[] = [
  { page: 'Proxies', path: `/proxies${PAGE}`, scoped: true, check: paginated },
  { page: 'Upstreams', path: `/upstreams${PAGE}`, scoped: true, check: paginated },
  { page: 'Consumers', path: `/consumers${PAGE}`, scoped: true, check: paginated },
  { page: 'Plugins', path: `/plugins/config${PAGE}`, scoped: true, check: paginated },
  {
    page: 'Plugins',
    path: '/plugins',
    check: (body) => Array.isArray(body) && body.length > 0 && body.every((name) => typeof name === 'string')
      ? null : 'not a non-empty list of plugin names',
  },
  { page: 'Settings', path: `/namespaces${PAGE}`, check: paginated },
  {
    page: 'Settings',
    path: '/backup',
    scoped: true,
    check: fields({
      version: 'string', ferrum_version: 'string', exported_at: 'string', source: 'string', counts: 'object',
      proxies: 'array', consumers: 'array', plugin_configs: 'array', upstreams: 'array',
    }),
  },
  { page: 'API Specs', path: `/api-specs${PAGE}`, scoped: true, absent: DATABASE_BACKED, check: itemPage },
  { page: 'Audit', path: `/audit${PAGE}`, scoped: true, absent: DATABASE_BACKED, check: itemPage },
  {
    page: 'Dashboard, Metrics',
    path: '/admin/metrics',
    check: fields({
      'gateway.mode': 'string', 'gateway.ferrum_version': 'string', 'gateway.uptime_seconds': 'number',
      'gateway.total_requests': 'number', 'gateway.requests_per_second': 'number',
      'gateway.status_codes_total': 'object', 'gateway.config_source_status': 'string',
      'gateway.proxy_count': 'number', connection_pools: 'object', circuit_breakers: 'array',
      health_check: 'object', load_balancers: 'object', caches: 'object', consumer_index: 'object',
      rate_limiting: 'object',
    }),
  },
  {
    page: 'Metrics',
    path: '/metrics',
    text: true,
    check: (body) => typeof body === 'string' && PROMETHEUS_TYPE_PATTERN.test(body)
      ? null : 'no Prometheus # TYPE line',
  },
  {
    page: 'Metrics',
    path: '/metrics/runtime',
    check: fields({ timestamp: 'string', uptime_seconds: 'number', mode: 'string', ferrum_version: 'string' }),
  },
  {
    page: 'Metrics',
    path: '/overload',
    check: (body) => isObject(body) && ['normal', 'pressure', 'critical'].includes(String(body.level))
      ? null : 'no overload level',
  },
  { page: 'Metrics', path: '/charges?format=json', check: (body) => (isObject(body) ? null : 'not an object') },
  {
    page: 'Metrics',
    path: '/charges/sink/status',
    check: fields({
      enabled: 'boolean', instance_count: 'number', 'totals.per_event': 'object', 'totals.queue': 'object',
      'totals.spool': 'object', 'totals.export': 'object', instances: 'array',
    }),
  },
  {
    page: 'Cluster',
    path: '/cluster',
    check: (body) => {
      if (!isObject(body) || typeof body.mode !== 'string') return 'no mode';
      if (body.mode === 'cp') {
        return fields({
          connected_data_planes: 'number',
          data_planes: 'array',
          connected_mesh_nodes: 'number',
          mesh_nodes: 'array',
        })(body);
      }
      if (body.mode === 'dp') return fields({ control_plane: 'object|null' })(body);
      return fields({ message: 'string' })(body);
    },
  },
  {
    page: 'Cluster', path: '/backend-capabilities', absent: { cp: 503 }, check: fields({ entries: 'array' }),
  },
  { page: 'TLS', path: `/admin/tls/inventory${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/events${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/certificates${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/ca-bundles${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/crls${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/ocsp-responses${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/jwks${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/acme/certificates${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/acme/orders${PAGE}`, check: paginated },
  { page: 'TLS', path: `/admin/tls/acme/accounts${PAGE}`, check: paginated },
  { page: 'Mesh', path: `/gateway-trust-bundles${PAGE}`, scoped: true, check: paginated },
  {
    page: 'Mesh',
    path: '/gateway-trust/status',
    scoped: true,
    absent: DATABASE_BACKED,
    check: fields({
      namespace: 'string', configured: 'boolean', authority_unresolved: 'boolean', generation: 'string',
      process: 'object',
    }),
  },
  {
    page: 'Mesh',
    path: '/mesh/service-graph',
    absent: MESH_ONLY,
    check: fields({ generated_at: 'string', edge_count: 'number', edges: 'array' }),
  },
  {
    page: 'Mesh',
    path: '/mesh/egress-scope',
    // The sidecar's mesh document configures no egress scope; a gateway
    // without proxy state answers with its typed 503.
    absent: { file: 404, cp: 503, dp: 404, mesh: 404, database: 404 },
    check: fields({ namespace: 'string', scope: 'object', 'scope.sidecar_enforced': 'boolean', health: 'object' }),
  },
  // No fixture configures federation or a waypoint: the reads must stay a
  // clean "not served" answer the tabs render as an empty state.
  { page: 'Mesh', path: '/mesh/federation', absent: NEVER, check: fields({ bundles: 'array' }) },
  {
    page: 'Mesh',
    path: '/mesh/remote-clusters',
    absent: MESH_ONLY,
    check: fields({ discovery_enabled: 'boolean', discovered: 'array', configured: 'array' }),
  },
  {
    page: 'Mesh',
    path: '/mesh/runtime-overlay',
    absent: MESH_ONLY,
    // `getRuntimeOverlay`'s own decoder (src/api/mesh.ts).
    check: (body) => {
      const shape = fields({ namespace: 'string', version: 'string', runtime_overlay: 'object' })(body);
      if (shape) return shape;
      const overlay = (body as { runtime_overlay: Record<string, unknown> }).runtime_overlay;
      return 'fields' in overlay && !isObject(overlay.fields) ? 'runtime_overlay.fields is not an object' : null;
    },
  },
  {
    page: 'Mesh',
    path: '/mesh/config-drift',
    absent: MESH_ONLY,
    check: fields({
      slice: 'object', 'slice.resources': 'object', 'slice.source_protocol': 'string', revision: 'object',
      'revision.rejected_total': 'number', 'revision.quarantine_active': 'boolean',
    }),
  },
  {
    page: 'Mesh',
    path: '/mesh/slice-drift',
    // Served by the control plane.
    absent: { file: 404, dp: 404, mesh: 404, database: 404 },
    check: fields({ mode: 'string', generated_at: 'string', summary: 'object', data_planes: 'array' }),
  },
  {
    page: 'Mesh',
    path: '/mesh/policy-denies/recent',
    absent: MESH_ONLY,
    check: fields({ window_seconds: 'number', limit: 'number', total_denies: 'number', grouped: 'array' }),
  },
  {
    page: 'Mesh',
    path: '/node-waypoint/identities',
    absent: { file: 404, cp: 503, dp: 404, mesh: 404, database: 404 },
    check: fields({ identity_count: 'number', identities: 'array' }),
  },
  {
    page: 'Mesh',
    path: '/service-waypoint/services',
    absent: NEVER,
    check: fields({ waypoint_name: 'string', services: 'array' }),
  },
];

/** The editors' detail reads: the first listed row of each collection. */
const DETAIL_COLLECTIONS = ['proxies', 'upstreams', 'consumers', 'plugins/config'] as const;

/** The proxy each mode's fixture creates, which its list must carry. */
const FIXTURE_PROXY: Partial<Record<Mode, string>> = {
  file: 'modes-file-proxy',
  // Created on the CP through Foundry by server/routes/cp-dp-sync.gateway.test.ts.
  cp: 'modes-cpdp-proxy',
  dp: 'modes-cpdp-proxy',
};

interface Target {
  mode: Mode;
  adminUrl: string;
}

/** `mode@url,mode@url` from FERRUM_PAGE_READ_TARGETS. */
function targets(): Target[] {
  return (process.env.FERRUM_PAGE_READ_TARGETS ?? '').split(',').filter(Boolean).map((entry) => {
    const at = entry.indexOf('@');
    return { mode: entry.slice(0, at) as Mode, adminUrl: entry.slice(at + 1) };
  });
}

function errorDetail(response: { body: string; json: () => unknown }): string {
  let detail = response.body.slice(0, 160).replace(WHITESPACE_RUNS_PATTERN, ' ');
  try {
    const error = (response.json() as { error?: unknown }).error;
    if (typeof error === 'string') detail = error.slice(0, 160);
  } catch {
    // Keep the raw prefix.
  }
  return detail;
}

// Executed by the Gateway Modes CI job only, against its disposable gateway.
it.runIf(process.env.FERRUM_PAGE_READS_GATEWAY_CONTRACT === 'true')(
  'answers every page read through the BFF in this gateway mode',
  async () => {
    const namespace = process.env.FERRUM_NAMESPACE ?? 'ferrum-foundry-demo';
    const failures: string[] = [];
    const rows: string[] = [];
    for (const target of targets()) {
      const proof = 'hosted-page-read-proof-long-enough-xx';
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('FERRUM_ADMIN_URL', target.adminUrl);
      vi.stubEnv('FERRUM_AUTH_MODE', 'trusted-proxy');
      vi.stubEnv('FERRUM_TRUSTED_PROXY_SECRET', proof);
      vi.stubEnv('FERRUM_SECURE_COOKIES', 'false');
      vi.resetModules();
      const { buildApp } = await import('../app.js');
      const app = await buildApp({ serveStatic: false, logger: false });
      try {
        // Administrators: an unrestricted one for fleet reads, and one granted
        // the namespace for namespace reads.
        async function signIn(grants?: string) {
          const identity: Record<string, string> = {
            'x-ferrum-auth-secret': proof, 'x-forwarded-user': `page-read-admin-${grants ?? 'fleet'}`,
            'x-ferrum-role': 'admin', ...(grants ? { 'x-ferrum-namespaces': grants } : {}),
          };
          const opened = await app.inject({ method: 'GET', url: '/api/auth/session', headers: identity });
          expect(opened.statusCode).toBe(200);
          return {
            ...identity,
            cookie: opened.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
            'x-ferrum-namespace': namespace,
          };
        }
        const headers = await signIn();
        const scopedHeaders = await signIn(namespace);

        const health = await app.inject({ method: 'GET', url: '/api/proxy/health', headers });
        const snapshot: unknown = health.json();
        const reportedMode = (snapshot as { mode?: unknown } | null)?.mode;
        rows.push(`| ${target.mode} | Status | \`/health\` | ${health.statusCode} | mode \`${String(reportedMode)}\` |`);
        if (!isGatewayHealthSnapshot(snapshot) || health.statusCode !== 200) {
          failures.push(`${target.mode} /health: ${health.statusCode}${isGatewayHealthSnapshot(snapshot) ? '' : ' without a valid snapshot'}`);
        } else if (reportedMode !== target.mode) {
          failures.push(`${target.mode} /health: reports mode ${String(reportedMode)}`);
        }

        const listed = new Map<string, unknown[]>();
        for (const read of PAGE_READS) {
          const response = await app.inject({
            method: 'GET', url: `/api/proxy${read.path}`, headers: read.scoped ? scopedHeaders : headers,
          });
          const status = response.statusCode;
          const absentStatus = read.absent?.[target.mode];
          let note = '';
          if (absentStatus !== undefined) {
            note = `not served (fixture leaves it off, expects ${absentStatus})`;
            if (status !== absentStatus) {
              note = `${status}, expected ${absentStatus}: ${errorDetail(response)}`;
              failures.push(`${target.mode} ${read.page} ${read.path}: ${note}`);
            }
          } else if (status === 200) {
            let body: unknown = response.body;
            if (!read.text) {
              try {
                body = JSON.parse(response.body);
              } catch {
                body = undefined;
              }
            }
            const wrong = body === undefined ? 'unparseable JSON' : read.check(body);
            if (wrong) {
              note = wrong;
              failures.push(`${target.mode} ${read.page} ${read.path}: 200 but ${wrong}`);
            } else if (isObject(body) && Array.isArray(body.data)) {
              listed.set(read.path.split('?')[0], body.data);
            }
          } else {
            note = errorDetail(response);
            failures.push(`${target.mode} ${read.page} ${read.path}: ${status} ${note}`);
          }
          rows.push(`| ${target.mode} | ${read.page} | \`${read.path.split('?')[0]}\` | ${status} | ${tableCell(note)} |`);
        }

        // The fixture's proxy is listed where the job created one.
        const fixtureProxy = FIXTURE_PROXY[target.mode];
        const proxies = (listed.get('/proxies') ?? []) as { id?: unknown }[];
        if (fixtureProxy && !proxies.some((proxy) => proxy.id === fixtureProxy)) {
          failures.push(`${target.mode} /proxies does not list the fixture proxy ${fixtureProxy}`);
        }
        if (target.mode === 'database' && proxies.length === 0) {
          failures.push('database /proxies is empty after the demo seed');
        }
        const requiredMeshIds = new Map<string, string>();
        if (target.mode === 'mesh') {
          const proxyIds = proxies
            .map((proxy) => proxy.id)
            .filter((id): id is string => typeof id === 'string');
          const pluginIds = ((listed.get('/plugins/config') ?? []) as { id?: unknown }[])
            .map((plugin) => plugin.id)
            .filter((id): id is string => typeof id === 'string');
          const sidecarProxyId = proxyIds.find((id) => id.startsWith('__mesh-') && !isAddressableResourceId(id));
          if (!sidecarProxyId) {
            failures.push(`mesh /proxies does not list a generated sidecar proxy (got ${proxyIds.join(', ') || 'none'})`);
          } else {
            requiredMeshIds.set('proxies', sidecarProxyId);
          }
          if (!pluginIds.some((id) => id === '__mesh_spiffe_identity' && !isAddressableResourceId(id))) {
            failures.push(`mesh /plugins/config does not list __mesh_spiffe_identity (got ${pluginIds.join(', ') || 'none'})`);
          } else {
            requiredMeshIds.set('plugins/config', '__mesh_spiffe_identity');
          }
        }

        // Proxy-detail filtered reads (`GET /plugins/config?proxy_id=…` and,
        // on database-backed modes, `GET /api-specs?offset=0&limit=2&proxy_id=…`).
        const listedPlugins = (listed.get('/plugins/config') ?? []) as { id?: unknown; proxy_id?: unknown }[];
        const expectedProxyBoundPlugin = target.mode === 'database'
          ? { id: 'demo-proxy-catalog-key-auth', proxy_id: 'demo-proxy-catalog' }
          : listedPlugins.find(
              (row): row is { id: string; proxy_id: string } =>
                typeof row.id === 'string' && typeof row.proxy_id === 'string' && row.proxy_id.length > 0,
            );
        const filterProxyId = expectedProxyBoundPlugin?.proxy_id ?? fixtureProxy ?? proxies
          .map((proxy) => proxy.id)
          .find((id): id is string => typeof id === 'string' && isAddressableResourceId(id));
        const absentProxyId = 'modes-no-such-proxy-filter';
        const filteredPluginsAbsent = await app.inject({
          method: 'GET',
          url: `/api/proxy/plugins/config${PAGE}&proxy_id=${encodeURIComponent(absentProxyId)}`,
          headers: scopedHeaders,
        });
        const filteredPluginsAbsentBody = filteredPluginsAbsent.statusCode === 200
          ? JSON.parse(filteredPluginsAbsent.body) as { data?: unknown[] }
          : null;
        if (
          filteredPluginsAbsent.statusCode !== 200 ||
          paginated(filteredPluginsAbsentBody) !== null ||
          (filteredPluginsAbsentBody?.data?.length ?? -1) !== 0
        ) {
          failures.push(
            `${target.mode} filtered /plugins/config?proxy_id=${absentProxyId}: ` +
            `status ${filteredPluginsAbsent.statusCode}, count ${String(filteredPluginsAbsentBody?.data?.length)}`,
          );
        }
        rows.push(
          `| ${target.mode} | Proxy detail | \`/plugins/config?proxy_id=…\` | ${filteredPluginsAbsent.statusCode} | ${tableCell(`absent proxy returned ${String(filteredPluginsAbsentBody?.data?.length ?? 'n/a')} rows`)} |`,
        );
        if (filterProxyId) {
          const filteredPluginsHit = await app.inject({
            method: 'GET',
            url: `/api/proxy/plugins/config${PAGE}&proxy_id=${encodeURIComponent(filterProxyId)}`,
            headers: scopedHeaders,
          });
          const filteredPluginsHitBody = filteredPluginsHit.statusCode === 200
            ? JSON.parse(filteredPluginsHit.body) as { data?: { id?: unknown; proxy_id?: unknown }[] }
            : null;
          let wrong = filteredPluginsHit.statusCode !== 200
            ? `${filteredPluginsHit.statusCode} ${errorDetail(filteredPluginsHit)}`
            : paginated(filteredPluginsHitBody);
          if (!wrong && filteredPluginsHitBody?.data) {
            if (!filteredPluginsHitBody.data.every((row) => row.proxy_id === filterProxyId)) {
              wrong = `returned rows not bound to proxy_id=${filterProxyId}`;
            } else if (
              expectedProxyBoundPlugin &&
              expectedProxyBoundPlugin.proxy_id === filterProxyId &&
              !filteredPluginsHitBody.data.some((row) => row.id === expectedProxyBoundPlugin.id)
            ) {
              wrong = `missing expected proxy-bound plugin ${expectedProxyBoundPlugin.id}`;
            }
          }
          if (wrong) {
            failures.push(`${target.mode} filtered /plugins/config?proxy_id=${filterProxyId}: ${wrong}`);
          }
        }
        const filteredSpecsAbsent = await app.inject({
          method: 'GET',
          url: `/api/proxy/api-specs?offset=0&limit=2&proxy_id=${encodeURIComponent(absentProxyId)}`,
          headers: scopedHeaders,
        });
        const expectedSpecsAbsent = DATABASE_BACKED[target.mode];
        if (expectedSpecsAbsent !== undefined) {
          if (filteredSpecsAbsent.statusCode !== expectedSpecsAbsent) {
            failures.push(
              `${target.mode} filtered /api-specs?proxy_id=${absentProxyId}: ${filteredSpecsAbsent.statusCode}, expected ${expectedSpecsAbsent}`,
            );
          }
        } else {
          const filteredSpecsBody = filteredSpecsAbsent.statusCode === 200
            ? JSON.parse(filteredSpecsAbsent.body) as { items?: unknown[]; limit?: unknown; offset?: unknown; next_offset?: unknown; total?: unknown }
            : null;
          if (
            filteredSpecsAbsent.statusCode !== 200 ||
            itemPage(filteredSpecsBody) !== null ||
            (filteredSpecsBody?.items?.length ?? -1) !== 0 ||
            filteredSpecsBody?.total !== 0 ||
            filteredSpecsBody?.limit !== 2 ||
            filteredSpecsBody?.offset !== 0 ||
            filteredSpecsBody?.next_offset !== null
          ) {
            failures.push(
              `${target.mode} filtered /api-specs?limit=2&proxy_id=${absentProxyId}: ` +
              `status ${filteredSpecsAbsent.statusCode}, body ${JSON.stringify(filteredSpecsBody)}`,
            );
          }
        }
        rows.push(
          `| ${target.mode} | Proxy detail | \`/api-specs?limit=2&proxy_id=…\` | ${filteredSpecsAbsent.statusCode} | ${tableCell(expectedSpecsAbsent !== undefined ? `not served (expects ${expectedSpecsAbsent})` : 'empty limit=2 page for absent proxy')} |`,
        );

        // Detail reads, as the editors open a row: the first row Edge serves
        // by ID. A row outside Edge's ID grammar (a mesh sidecar's
        // runtime-generated `__mesh…` rows) gets no detail page in Foundry
        // (`isAddressableResourceId`); hold that to Edge's own refusal.
        for (const collection of DETAIL_COLLECTIONS) {
          const ids = ((listed.get(`/${collection}`) ?? []) as { id?: unknown }[])
            .map((row) => row.id)
            .filter((id): id is string => typeof id === 'string');
          const generated = requiredMeshIds.get(collection) ?? ids.find((id) => !isAddressableResourceId(id));
          if (generated !== undefined) {
            const refused = await app.inject({
              method: 'GET', url: `/api/proxy/${collection}/${encodeURIComponent(generated)}`, headers: scopedHeaders,
            });
            rows.push(`| ${target.mode} | Detail | \`/${collection}/{generated id}\` | ${refused.statusCode} | Foundry offers no detail page |`);
            if (refused.statusCode !== 400) {
              failures.push(`${target.mode} detail of generated ${collection} row ${generated}: ${refused.statusCode}, expected Edge's 400`);
            }
          }
          const firstId = ids.find(isAddressableResourceId);
          if (firstId === undefined) continue;
          const first = { id: firstId };
          const path = `/${collection}/${encodeURIComponent(first.id)}`;
          const response = await app.inject({ method: 'GET', url: `/api/proxy${path}`, headers: scopedHeaders });
          let id: unknown;
          try {
            id = (response.json() as { id?: unknown }).id;
          } catch {
            id = undefined;
          }
          const ok = response.statusCode === 200 && id === first.id;
          rows.push(`| ${target.mode} | Detail | \`/${collection}/{id}\` | ${response.statusCode} | ${ok ? '' : tableCell(errorDetail(response))} |`);
          if (!ok) failures.push(`${target.mode} detail ${path}: ${response.statusCode}, id ${String(id)}`);
        }

        // The Metrics page and the Dashboard hide /admin/metrics values that
        // adminMetricsReporting calls placeholders. Hold that decision to what
        // this gateway serves: Edge's skeleton (`empty_proxy_metrics`, used
        // without proxy state) has no config snapshot time and a zero metrics
        // window; a gateway with proxy state reports both.
        const metrics = await app.inject({ method: 'GET', url: '/api/proxy/admin/metrics', headers });
        if (metrics.statusCode === 200) {
          const gateway = (metrics.json() as { gateway?: Record<string, unknown> }).gateway ?? {};
          const skeleton =
            gateway.config_last_updated_at === null && gateway.metrics_window_seconds === 0 &&
            gateway.uptime_seconds === 0 && gateway.proxy_count === 0;
          const reportsRuntime = adminMetricsReporting(String(gateway.mode)).reportsProxyRuntime;
          rows.push(
            `| ${target.mode} | Metrics | \`/admin/metrics\` placeholders | ${metrics.statusCode} | ` +
              `${skeleton ? 'skeleton' : 'measured'}; Foundry ${reportsRuntime ? 'shows' : 'hides'} runtime values |`,
          );
          if (gateway.mode !== target.mode) {
            failures.push(`${target.mode} /admin/metrics: reports mode ${String(gateway.mode)}`);
          } else if (skeleton === reportsRuntime) {
            failures.push(
              `${target.mode} /admin/metrics: the gateway serves ${skeleton ? 'the no-proxy-state skeleton' : 'measured runtime values'}, ` +
                `but adminMetricsReporting ${reportsRuntime ? 'shows' : 'hides'} them`,
            );
          }
        }
      } finally {
        await app.close();
      }
    }

    const report = [
      `### Page reads through the BFF: ${targets().map((target) => target.mode).join(', ')}`,
      '',
      '| Mode | Page | Read | Status | Note |',
      '| --- | --- | --- | ---: | --- |',
      ...rows,
      '',
    ].join('\n');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    expect(failures, failures.join('\n')).toEqual([]);
  },
  300_000,
);
