#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Mock Ferrum Edge admin API for local Foundry development.         */
/*                                                                    */
/*  Serves realistic sample data for every admin surface the UI       */
/*  consumes — CRUD resources, TLS management, ACME, audit, cluster,  */
/*  mesh observability, overload/runtime/chargeback metrics — so the  */
/*  dashboard can be exercised without a running gateway.             */
/*                                                                    */
/*    node scripts/mock-admin-gateway.mjs        # listens on :9000   */
/* ------------------------------------------------------------------ */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_ADMIN_PORT ?? 9000);
const now = () => new Date().toISOString();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

/* ---------------- In-memory stores ---------------- */

const proxies = [
  {
    id: 'proxy-orders-api', namespace: 'ferrum', name: 'Orders API',
    listen_path: '/orders', hosts: ['api.example.com'], backend_scheme: 'https',
    backend_host: 'orders.internal', backend_port: 8443, backend_path: null,
    strip_listen_path: true, preserve_host_header: false,
    backend_connect_timeout_ms: 5000, backend_read_timeout_ms: 30000,
    backend_write_timeout_ms: 30000, backend_tls_verify_server_cert: true,
    auth_mode: 'single', plugins: [{ plugin_config_id: 'plg-rate-limit' }],
    upstream_id: 'upstream-orders', upstream_subset: null, listen_port: null,
    frontend_tls: false, passthrough: false, udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [], response_body_mode: 'stream',
    circuit_breaker: { failure_threshold: 5, success_threshold: 3, timeout_seconds: 30, failure_status_codes: [500, 502, 503, 504], half_open_max_requests: 1, trip_on_connection_errors: true },
    retry: null, api_spec_id: 'spec-orders',
    created_at: ago(2000), updated_at: ago(30),
  },
  {
    id: 'proxy-mqtt-broker', namespace: 'ferrum', name: 'MQTT Broker',
    listen_path: null, hosts: ['mqtt.example.com'], backend_scheme: 'tcps',
    backend_host: 'mqtt.internal', backend_port: 8883, strip_listen_path: true,
    preserve_host_header: false, backend_connect_timeout_ms: 5000,
    backend_read_timeout_ms: 0, backend_write_timeout_ms: 0,
    backend_tls_verify_server_cert: true, auth_mode: 'single', plugins: [],
    listen_port: 8883, frontend_tls: false, passthrough: true,
    stream_proxy_protocol: true, udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [], response_body_mode: 'stream',
    created_at: ago(5000), updated_at: ago(400),
  },
];

const upstreams = [
  {
    id: 'upstream-orders', namespace: 'ferrum', name: 'Orders Pool',
    targets: [
      { host: '10.0.2.11', port: 8443, weight: 2, tags: { version: 'v1' }, locality: 'us-east/az1', path: null },
      { host: '10.0.2.12', port: 8443, weight: 1, tags: { version: 'v2', tier: 'canary' }, locality: 'us-east/az2', path: null },
    ],
    algorithm: 'weighted_round_robin', hash_on: null,
    subsets: [{ name: 'canary', labels: { tier: 'canary' }, traffic_policy: null }],
    health_checks: {
      active: { http_path: '/health', interval_seconds: 10, timeout_ms: 5000, healthy_threshold: 3, unhealthy_threshold: 3, healthy_status_codes: [200, 302], probe_type: 'http', use_tls: true },
      passive: { unhealthy_status_codes: [500, 502, 503, 504], unhealthy_threshold: 3, unhealthy_window_seconds: 30, healthy_after_seconds: 30, max_ejection_percent: 50 },
    },
    backend_tls_verify_server_cert: true, backend_tls_sni: 'orders.internal',
    backend_tls_san_allow_list: [], api_spec_id: null,
    created_at: ago(2000), updated_at: ago(100),
  },
];

const consumers = [
  {
    id: 'consumer-mobile-app', namespace: 'ferrum', username: 'mobile-app',
    custom_id: 'crm-4411',
    credentials: {
      keyauth: [{ key: '[REDACTED]' }, { key: '[REDACTED]' }],
      jwt: [{ secret: '[REDACTED]' }],
      mtls_auth: [{ identity: 'CN=mobile.example.com' }],
    },
    acl_groups: ['mobile', 'premium'],
    created_at: ago(9000), updated_at: ago(600),
  },
];

const pluginConfigs = [
  {
    id: 'plg-rate-limit', namespace: 'ferrum', plugin_name: 'rate_limiting',
    config: { limit_by: 'consumer', requests_per_second: 400, sync_mode: 'local', expose_headers: true },
    scope: 'proxy', proxy_id: 'proxy-orders-api', enabled: true,
    priority_override: null, trigger: null, api_spec_id: null,
    created_at: ago(2000), updated_at: ago(2000),
  },
  {
    id: 'plg-waf', namespace: 'ferrum', plugin_name: 'waf',
    config: { mode: 'enforce', paranoia_level: 1, include_default_rules: true },
    scope: 'global', proxy_id: null, enabled: true, priority_override: null,
    trigger: { when: { match: { path: { prefix: ['/orders'] } } } },
    api_spec_id: null, created_at: ago(1500), updated_at: ago(100),
  },
  {
    id: 'plg-ai-guard', namespace: 'ferrum', plugin_name: 'ai_prompt_shield',
    config: { action: 'reject', detectors: ['email', 'credit_card'] },
    scope: 'global', proxy_id: null, enabled: false, priority_override: 2000,
    trigger: null, api_spec_id: null, created_at: ago(300), updated_at: ago(300),
  },
];

const AVAILABLE_PLUGINS = [
  'access_control', 'adaptive_concurrency', 'a2a_gateway', 'ai_federation',
  'ai_prompt_compressor', 'ai_prompt_shield', 'ai_rate_limiter', 'ai_request_guard',
  'ai_response_guard', 'ai_semantic_cache', 'ai_semantic_firewall', 'ai_stream_router',
  'ai_token_metrics', 'ai_tool_governor', 'ai_transcript_audit', 'api_chargeback',
  'api_chargeback_sink', 'basic_auth', 'body_validator', 'bot_detection',
  'compression', 'correlation_id', 'cors', 'fault_injection', 'geo_restriction',
  'graphql', 'grpc_deadline', 'grpc_method_router', 'grpc_web', 'hmac_auth',
  'http_logging', 'ip_restriction', 'jwks_auth', 'jwt_auth', 'kafka_logging',
  'key_auth', 'ldap_auth', 'load_testing', 'loki_logging', 'mcp_gateway',
  'mesh_authz', 'mesh_outbound_registry', 'mesh_route_dispatch', 'mtls_auth',
  'oauth2_introspection', 'oidc_relying_party', 'opa', 'openapi_validator',
  'otel_tracing', 'prometheus_metrics', 'proxy_alerts', 'rate_limiting',
  'request_deduplication', 'request_mirror', 'request_size_limiting',
  'request_termination', 'request_transformer', 'response_caching',
  'response_mock', 'response_size_limiting', 'response_transformer',
  'security_headers', 'serverless_function', 'soap_ws_security', 'spec_expose',
  'spiffe_identity', 'sse', 'statsd_logging', 'stdout_logging',
  'tcp_connection_throttle', 'tcp_logging', 'transaction_debugger',
  'transaction_log_schema', 'udp_logging', 'udp_rate_limiting', 'waf',
  'workload_metrics', 'ws_frame_logging', 'ws_logging',
  'ws_message_size_limiting', 'ws_rate_limiting',
];

const managedTls = {
  certificates: [
    { id: 'edge-cert', name: 'Edge Certificate', kind: 'certificate', source_uri: 'managed://certificates/edge-cert', subject: 'CN=api.example.com', issuer: 'CN=Example Intermediate CA', sans: ['api.example.com'], not_before: ago(50000), not_after: new Date(Date.now() + 62 * 86400000).toISOString(), fingerprint_sha256: 'ab12cd34ef56', certificate_count: 2, byte_length: 4096, created_at: ago(50000), updated_at: ago(2000) },
  ],
  'ca-bundles': [
    { id: 'client-ca', name: 'Client CA Bundle', kind: 'ca_bundle', source_uri: 'managed://ca-bundles/client-ca', subject: 'CN=Example Client CA', certificate_count: 3, byte_length: 6144, created_at: ago(40000), updated_at: ago(40000) },
  ],
  crls: [], 'ocsp-responses': [], jwks: [
    { id: 'auth-jwks', name: 'Auth Server JWKS', kind: 'jwks', source_uri: 'managed://jwks/auth-jwks', byte_length: 2048, created_at: ago(10000), updated_at: ago(500) },
  ],
};

const acmeCerts = [
  { id: 'acme-edge', domains: ['edge.example.com'], directory_url: 'https://acme-v02.api.letsencrypt.org/directory', status: 'issued', source_uri: 'acme://certificates/acme-edge', subject: 'CN=edge.example.com', not_after: new Date(Date.now() + 21 * 86400000).toISOString(), issued_at: ago(80000), created_at: ago(80000), updated_at: ago(80000) },
];
const acmeOrders = [
  { id: 'order-renew-edge', certificate_id: 'acme-edge', domains: ['edge.example.com'], directory_url: 'https://acme-v02.api.letsencrypt.org/directory', status: 'pending_challenges', http01_challenges: [{ identifier: 'edge.example.com', token: 'tok123', key_authorization: 'tok123.abc', path: '/.well-known/acme-challenge/tok123' }], created_at: ago(10), updated_at: ago(5) },
];

const auditEvents = Array.from({ length: 24 }, (_, i) => ({
  id: randomUUID(),
  ts: ago(i * 47 + 3),
  actor: i % 3 === 0 ? 'ci-deployer' : 'admin@example.com',
  action: ['create', 'update', 'delete', 'update'][i % 4],
  resource_type: ['proxy', 'plugin_config', 'consumer', 'upstream'][i % 4],
  resource_id: ['proxy-orders-api', 'plg-rate-limit', 'consumer-mobile-app', 'upstream-orders'][i % 4],
  namespace: 'ferrum',
  source_address: '10.1.0.5',
  request_id: `req-${1000 + i}`,
  outcome: i % 7 === 6 ? 'denied' : 'success',
  diff: { changed: { enabled: { from: false, to: true } } },
}));

// Mirror the real gateway: the spec summary title comes from the document's
// info.title, not a hardcoded placeholder.
function extractSpecTitle(doc) {
  try {
    if (doc.trimStart().startsWith('{')) {
      const title = JSON.parse(doc)?.info?.title;
      if (title) return String(title);
    } else {
      const m = doc.match(/^\s*title:\s*['"]?(.+?)['"]?\s*$/m);
      if (m) return m[1];
    }
  } catch {
    // fall through to placeholder
  }
  return 'Imported Spec';
}

const apiSpecs = [
  {
    id: 'spec-orders', proxy_id: 'proxy-orders-api', namespace: 'ferrum',
    spec_version: '3.1.0', spec_format: 'yaml', title: 'Orders API',
    info_version: '2.4.0', description: 'Order management API', contact_name: null,
    contact_email: 'api@example.com', license_name: 'Apache-2.0',
    license_identifier: 'Apache-2.0', tags: ['orders', 'commerce'],
    server_urls: ['https://api.example.com/orders'], operation_count: 14,
    uncompressed_size: 48213, content_hash: 'deadbeef01', content_encoding: 'gzip',
    created_at: ago(20000), updated_at: ago(120),
  },
];
const specDocuments = {
  'spec-orders': `openapi: 3.1.0\ninfo:\n  title: Orders API\n  version: 2.4.0\nx-ferrum-proxy:\n  listen_path: /orders\n  backend_scheme: https\n  backend_host: orders.internal\n  backend_port: 8443\npaths:\n  /orders:\n    get:\n      summary: List orders\n      responses:\n        "200":\n          description: OK\n`,
};

const trustBundle = {
  id: 'ferrum', namespace: 'ferrum', trust_domain: 'prod.example.com',
  bundle: {
    local: { trust_domain: 'prod.example.com', x509_authorities: ['MIIB...'], jwt_authorities: [{ key_id: 'kid-1', public_key_pem: '-----BEGIN PUBLIC KEY-----...' }], refresh_hint_seconds: 300 },
    federated: [{ trust_domain: 'partner.example.org', x509_authorities: ['MIIC...'] }],
  },
  revision: 7, updated_by: 'admin@example.com', created_at: ago(30000), updated_at: ago(500),
};

/* ---------------- Namespace registry ---------------- */

const PROTECTED_NAMESPACE = 'ferrum';
const NAMESPACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const namespaceRegistry = new Map([
  ['ferrum', { name: 'ferrum', description: 'Default namespace', created_at: ago(90000), updated_at: ago(90000) }],
  ['staging', { name: 'staging', created_at: ago(45000), updated_at: ago(45000) }],
]);

function namespaceHasResources(name) {
  return [...proxies, ...consumers, ...pluginConfigs, ...upstreams, ...apiSpecs]
    .some((r) => r.namespace === name);
}

function normalizeNamespaceDescription(description) {
  return typeof description === 'string' ? description.trim() : '';
}

function validateNamespaceBody(body, nameRequired) {
  const hasName = body.name !== undefined;
  if (nameRequired && !hasName) return 'name is required';
  if (hasName && (typeof body.name !== 'string' || body.name.length > 254 || !NAMESPACE_NAME_PATTERN.test(body.name))) {
    return 'name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ and be at most 254 characters';
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') return 'description must be a string or null';
    if ([...body.description].length > 1024) return 'description must be at most 1024 characters';
  }
  return null;
}

/* ---------------- Helpers ---------------- */

function paginate(items, url) {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
  return {
    data: items.slice(offset, offset + limit),
    pagination: { offset, limit, total: items.length },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function crud(list, url, method, id, body, defaults = {}, ns = 'ferrum') {
  // The real gateway isolates resources per namespace; list responses must
  // reflect that or namespace occupancy counts are meaningless.
  if (method === 'GET' && !id) {
    return [200, paginate(list.filter((x) => (x.namespace ?? 'ferrum') === ns), url)];
  }
  if (method === 'GET') {
    const item = list.find((x) => x.id === id);
    return item ? [200, item] : [404, { error: 'not found' }];
  }
  if (method === 'POST') {
    const item = { id: randomUUID(), namespace: ns, ...defaults, ...body, created_at: now(), updated_at: now() };
    list.push(item);
    return [201, item];
  }
  if (method === 'PUT') {
    const index = list.findIndex((x) => x.id === id);
    if (index < 0) return [404, { error: 'not found' }];
    list[index] = { ...list[index], ...body, id, updated_at: now() };
    return [200, list[index]];
  }
  if (method === 'DELETE') {
    const index = list.findIndex((x) => x.id === id);
    if (index < 0) return [404, { error: 'not found' }];
    list.splice(index, 1);
    return [204, null];
  }
  return [405, { error: 'method not allowed' }];
}

/* ---------------- Static payloads ---------------- */

const health = {
  status: 'ok', ready: true, admin_writes_enabled: true, timestamp: now(),
  mode: 'database',
  database: { status: 'connected', type: 'sqlite', pool: { size: 5, idle: 4, active: 1, max_connections: 10 } },
  fips: { mode: 'off', enforcing: false, build_capable: false, build_profile: 'crypto-ring', provider: 'ring', module_self_test_passed: true, provider_algorithms_approved: false, certified: false, boundary_documentation: 'docs/fips.md' },
  cached_config: { available: true, loaded_at: ago(2), proxy_count: proxies.length, consumer_count: consumers.length },
};

const adminMetrics = () => ({
  gateway: {
    mode: 'database', ferrum_version: '1.4.2', uptime_seconds: 86423,
    total_requests: 1523401, requests_per_second: 118,
    status_codes_total: { 200: 1420031, 201: 52011, 404: 21892, 429: 3312, 500: 1204, 502: 240 },
    status_codes_per_second: { 200: 104, 201: 6, 404: 5, 429: 2, 500: 1 },
    metrics_window_seconds: 30, config_last_updated_at: ago(12),
    config_source_status: 'online', proxy_count: proxies.length,
    consumer_count: consumers.length, upstream_count: upstreams.length,
    plugin_config_count: pluginConfigs.length,
  },
  connection_pools: {
    http: { total_pools: 3, max_idle_per_host: 32, idle_timeout_seconds: 90, entries_per_host: { 'orders.internal:8443:tls': 12, 'mqtt.internal:8883:tls': 2 } },
    grpc: { total_connections: 4 }, http2: { total_connections: 9 }, http3: { total_connections: 2 },
  },
  circuit_breakers: [
    { namespace: 'ferrum', proxy_id: 'proxy-orders-api', target: '10.0.2.11:8443', state: 'closed', failure_count: 0, success_count: 0 },
    { namespace: 'ferrum', proxy_id: 'proxy-orders-api', target: '10.0.2.12:8443', state: 'half_open', failure_count: 5, success_count: 2 },
  ],
  health_check: {
    unhealthy_target_count: 1,
    unhealthy_targets: [{ namespace: 'ferrum', upstream_id: 'upstream-orders', target: '10.0.2.12:8443', type: 'active', since_epoch_ms: Date.now() - 320000 }],
  },
  load_balancers: {
    active_connections: [
      { namespace: 'ferrum', upstream_id: 'upstream-orders', targets: { '10.0.2.11:8443': 34, '10.0.2.12:8443': 11 } },
    ],
  },
  caches: {
    router: { prefix_cache_entries: 210, regex_cache_entries: 44, prefix_eviction_count: 3, regex_eviction_count: 0, max_cache_entries: 10000 },
    dns: { cache_entries: 12 },
  },
  consumer_index: { total_consumers: 1, key_auth_credentials: 2, basic_auth_credentials: 0, mtls_credentials: 1, jwt_credentials: 1, hmac_credentials: 0, identity_credentials: 3 },
  rate_limiting: { tracked_key_count: 412 },
  tcp_connection_throttle: { enforcement_scope: 'process_local', replica_limit_behavior: 'configured_limit_per_replica' },
});

const overload = {
  level: 'normal', draining: false, active_connections: 342, active_requests: 57,
  red_drop_probability_pct: 0, port_exhaustion_events: 0,
  pressure: {
    file_descriptors: { current: 812, max: 65536, ratio: 0.012 },
    connections: { current: 342, max: 20000, ratio: 0.017 },
    requests: { current: 57, max: 8000, ratio: 0.007 },
    event_loop_latency_us: 180,
  },
  actions: { disable_keepalive: false, reject_new_connections: false, reject_new_requests: false },
};

const runtimeMetrics = () => ({
  timestamp: now(), uptime_seconds: 86423, mode: 'database', ferrum_version: '1.4.2',
  system: {
    sampled_at_unix_ms: Date.now(), platform: 'linux',
    cpu: { process_percent: 8.4, system_percent: 22.1, cpu_count: 8 },
    memory: { rss_bytes: 412_000_000, virtual_bytes: 1_800_000_000, host_percent: 5.1 },
    file_descriptors: { current: 812, max: 65536, ratio: 0.012 },
    ephemeral_ports: { range_size: 28000, exhaustion_events: 0, active_outbound_estimate: 220 },
  },
  http: {
    total_requests: 1523401, requests_per_second_1s: 121, requests_per_second_1m: 118,
    requests_per_second_5m: 102, client_disconnects: 89,
    status_codes: { totals: { 200: 1420031, 404: 21892 }, rate_1m: { 200: 104, 404: 5 } },
  },
  errors: { by_class: { upstream_timeout: { http: 42 }, connect_failure: { http: 11, stream: 2 } } },
  dns: { lookups_total: 48211, cache_hits: 47100, cache_misses: 1111, stale_serves: 40, errors: 3, hit_ratio: 0.977, error_ratio: 0.0001, cache_entries: 12 },
  connections: { active: 342, active_requests: 57, pool_handshakes_total: { https: 1211 } },
  logs: { by_level: { info: 152000, warn: 214, error: 37 } },
  overload,
});

const charges = {
  currency: 'USD', generated_at: now(),
  registry: { entries: 2, max_entries: 100000, retained_bytes: 18211, max_retained_bytes: 104857600, dropped_charges_total: 0 },
  consumers: {
    'mobile-app': {
      total_charges: 42.1875, total_calls: 421875, per_call_charges: 42.1875,
      proxies: { 'proxy-orders-api': { proxy_id: 'proxy-orders-api', currency: 'USD', total_calls: 421875, total_charges: 42.1875 } },
    },
    anonymous: { total_charges: 1.02, total_calls: 10200 },
  },
};

const cluster = { mode: 'database', message: 'Standalone database-mode gateway — CP/DP topology not active.' };

const backendCapabilities = {
  entries: [
    { key: 'https|orders.internal|8443||||true|', plain_http: { h1: 'supported', h2_tls: 'supported', h3: 'supported' }, grpc_transport: { h2_tls: 'supported', h2c: 'unknown' }, hbone: 'unsupported', last_probe_at_unix_secs: Math.floor(Date.now() / 1000) - 300 },
    { key: 'tcps|mqtt.internal|8883||||true|', plain_http: { h1: 'unknown', h2_tls: 'unknown', h3: 'unsupported' }, grpc_transport: { h2_tls: 'unknown', h2c: 'unknown' }, hbone: 'unsupported', last_probe_at_unix_secs: Math.floor(Date.now() / 1000) - 3000, last_probe_error: 'not an HTTP backend' },
  ],
};

const tlsInventory = [
  { id: 'inv-edge-cert', material_kind: 'certificate', source: { kind: 'managed', identifier: 'managed://certificates/edge-cert', refreshable: true }, state: 'loaded', used_by: [{ surface: 'frontend_tls', role: 'server_certificate', resource_type: 'env', resource_id: 'FERRUM_TLS_CERT_PATH', field: 'cert' }], subject: 'CN=api.example.com', not_after: new Date(Date.now() + 62 * 86400000).toISOString(), days_until_expiry: 62, fingerprint_sha256: 'ab12cd34', certificate_count: 2 },
  { id: 'inv-edge-key', material_kind: 'private_key', source: { kind: 'managed', identifier: 'managed://certificates/edge-cert#key', refreshable: true }, state: 'loaded', used_by: [{ surface: 'frontend_tls', role: 'private_key', resource_type: 'env', resource_id: 'FERRUM_TLS_KEY_PATH', field: 'key' }] },
  { id: 'inv-old-ca', material_kind: 'ca_bundle', source: { kind: 'file', identifier: '/etc/ferrum/old-ca.pem', refreshable: true }, state: 'invalid', used_by: [], error: 'PEM parse error at byte 120' },
];

const tlsEvents = [
  { id: 3, at: ago(20), surface: 'proxy_https', outcome: 'rotated', sources: [{ label: 'cert', cert_id: 'inv-edge-cert', source_id: 'managed://certificates/edge-cert', scheme: 'managed', kind: 'cert', fingerprint_sha256: 'ab12cd34' }], revision: 4 },
  { id: 2, at: ago(1500), surface: 'backend_tls', outcome: 'load_error', sources: [{ label: 'ca', cert_id: 'inv-old-ca', source_id: '/etc/ferrum/old-ca.pem', scheme: 'file', kind: 'ca_bundle' }], error: 'PEM parse error at byte 120' },
];

const serviceGraphEdges = [
  { source_principal: 'spiffe://prod/ns/web/sa/frontend', source_workload: 'frontend-7d9', source_namespace: 'web', source_app: 'frontend', source_service: 'frontend', destination_principal: 'spiffe://prod/ns/api/sa/orders', destination_workload: 'orders-5f2', destination_namespace: 'api', destination_app: 'orders', destination_service: 'orders', request_protocol: 'http', connection_security_policy: 'mutual_tls', requests_total: 48211, errors_total: 12, duration_ms_total: 482110, duration_ms_avg: 10.0, last_seen_unix_ms: Date.now(), last_seen: now() },
];

const meshData = {
  'service-graph': {
    generated_at_unix_ms: Date.now(), generated_at: now(),
    // Keep the count derived so it always matches the rows the UI renders.
    edge_count: serviceGraphEdges.length,
    edges: serviceGraphEdges,
  },
};

/* ---------------- Server ---------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _raw: raw }; }

  const ns = (Array.isArray(req.headers['x-ferrum-namespace'])
    ? req.headers['x-ferrum-namespace'][0]
    : req.headers['x-ferrum-namespace']) || 'ferrum';

  const send = (status, payload, contentType = 'application/json') => {
    res.writeHead(status, { 'content-type': contentType });
    res.end(payload == null ? '' : contentType === 'application/json' ? JSON.stringify(payload) : payload);
  };

  /* health & metrics */
  if (path === '/health' || path === '/status') return send(200, health);
  if (path === '/admin/metrics') return send(200, adminMetrics());
  if (path === '/metrics') {
    return send(200, [
      '# TYPE ferrum_requests_total counter',
      'ferrum_requests_total{namespace="ferrum",proxy_id="proxy-orders-api",method="GET",status="200"} 1420031',
      'ferrum_requests_total{namespace="ferrum",proxy_id="proxy-orders-api",method="POST",status="201"} 52011',
      'ferrum_requests_total{namespace="ferrum",proxy_id="proxy-orders-api",method="GET",status="404"} 21892',
      '# TYPE ferrum_request_duration_seconds histogram',
      'ferrum_request_duration_seconds_sum{namespace="ferrum",proxy_id="proxy-orders-api"} 15234.2',
      'ferrum_request_duration_seconds_count{namespace="ferrum",proxy_id="proxy-orders-api"} 1493934',
    ].join('\n'), 'text/plain');
  }
  if (path === '/metrics/runtime') return send(200, runtimeMetrics());
  if (path === '/overload') return send(200, overload);
  if (path === '/charges') return send(200, charges);
  if (path === '/charges/sink/status') {
    return send(200, {
      enabled: true, instance_count: 1, snapshot_finalizations_pending: 0,
      snapshot_finalizations_pending_bytes: 0, snapshot_finalizations_oldest_age_secs: 0,
      snapshot_finalization_recovery_policy: 'replay',
      totals: { queue: { depth: 3, capacity: 10000, full_drops_total: 0 }, spool: { files: 0, bytes: 0, drops_total: 0, available: true }, export: { events_enqueued_total: 431875, events_exported_total: 431872, failures_total: 0 } },
      instances: [{ plugin_config_id: 'plg-sink', generation: 1, mode: 'per_event', pricing_version: 'v1', clickhouse: { endpoint: 'https://clickhouse.internal:8443', database: 'ferrum', table: 'charges_raw' }, batch: { size: 500, flush_interval_ms: 2000 }, retry: {}, queue: { depth: 3, capacity: 10000 }, spool: { enabled: true, available: true }, export: { events_exported_total: 431872, failures_total: 0, last_success_at: ago(1) } }],
    });
  }

  /* cluster & capabilities */
  if (path === '/cluster') return send(200, cluster);
  if (path === '/backend-capabilities' && method === 'GET') return send(200, backendCapabilities);
  if (path === '/backend-capabilities/refresh') return send(200, { status: 'refreshed' });

  /* mesh — sample graph; everything else 404s like a non-mesh gateway */
  if (path === '/mesh/service-graph') return send(200, meshData['service-graph']);
  if (path.startsWith('/mesh/') || path.startsWith('/node-waypoint') || path.startsWith('/service-waypoint')) {
    return send(404, { error: 'mesh mode not active' });
  }

  /* audit */
  if (path === '/audit') {
    let items = auditEvents;
    for (const key of ['actor', 'action', 'resource_type', 'resource_id']) {
      const value = url.searchParams.get(key);
      if (value) items = items.filter((e) => e[key] === value);
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const page = items.slice(offset, offset + limit);
    return send(200, { items: page, limit, offset, next_offset: offset + limit < items.length ? offset + limit : null, total: items.length });
  }

  /* trust */
  if (path === '/gateway-trust-bundles' && method === 'GET') return send(200, { data: [trustBundle], pagination: { offset: 0, limit: 100, total: 1 } });
  if (path === '/gateway-trust/status') {
    return send(200, {
      namespace: 'ferrum', configured: true, authority_unresolved: false, generation: 'sha256-77aa',
      bundle: { namespace: 'ferrum', trust_domain: 'prod.example.com', revision: 7, x509_authority_count: 1, jwt_authority_count: 1, federated_count: 1, updated_at: ago(500) },
      process: { published_generations_total: 7, load_rejections_total: 0, ambiguous_authority_total: 0, last_published_unix_seconds: Math.floor(Date.now() / 1000) - 30000, last_failure_reason: 'none' },
    });
  }

  /* api specs */
  if (path === '/api-specs' && method === 'GET') {
    return send(200, { items: apiSpecs, limit: 50, offset: 0, next_offset: null, total: apiSpecs.length });
  }
  if (path === '/api-specs' && method === 'POST') {
    const id = `spec-${randomUUID().slice(0, 8)}`;
    const doc = typeof body._raw === 'string' ? body._raw : JSON.stringify(body);
    specDocuments[id] = doc;
    apiSpecs.push({ id, proxy_id: `proxy-${id}`, namespace: 'ferrum', spec_version: '3.1.0', spec_format: doc.trimStart().startsWith('{') ? 'json' : 'yaml', title: extractSpecTitle(doc), info_version: '1.0.0', description: null, contact_name: null, contact_email: null, license_name: null, license_identifier: null, tags: [], server_urls: [], operation_count: 1, uncompressed_size: doc.length, content_hash: 'cafebabe', content_encoding: 'gzip', created_at: now(), updated_at: now() });
    return send(201, { id, proxy_id: `proxy-${id}`, spec_version: '3.1.0', content_hash: 'cafebabe' });
  }
  const specMatch = path.match(/^\/api-specs\/([^/]+)$/);
  if (specMatch) {
    const spec = apiSpecs.find((s) => s.id === specMatch[1]);
    if (!spec) return send(404, { error: 'not found' });
    if (method === 'GET') return send(200, specDocuments[spec.id] ?? '# document unavailable', 'application/yaml');
    if (method === 'PUT') {
      specDocuments[spec.id] = typeof body._raw === 'string' ? body._raw : JSON.stringify(body);
      spec.title = extractSpecTitle(specDocuments[spec.id]);
      spec.updated_at = now();
      return send(200, { id: spec.id, proxy_id: spec.proxy_id, spec_version: spec.spec_version, content_hash: 'cafebabe2' });
    }
    if (method === 'DELETE') {
      apiSpecs.splice(apiSpecs.indexOf(spec), 1);
      return send(204, null);
    }
  }

  /* TLS management */
  if (path === '/admin/tls/inventory') return send(200, paginate(tlsInventory, url));
  if (path === '/admin/tls/events') return send(200, paginate(tlsEvents, url));
  if (path === '/admin/tls/validate') return send(200, { valid: true, validated: { cert: { subject: 'CN=test', days_until_expiry: 90 } } });
  const rotateMatch = path.match(/^\/admin\/tls\/rotate\/([^/]+)$/);
  if (rotateMatch) return send(202, { accepted: true, requested_surface: rotateMatch[1], surface: rotateMatch[1] });
  if (path === '/admin/tls/acme/certificates' && method === 'GET') return send(200, paginate(acmeCerts, url));
  if (path === '/admin/tls/acme/orders' && method === 'GET') return send(200, paginate(acmeOrders, url));
  if (path === '/admin/tls/acme/orders' && method === 'POST') {
    const order = { id: `order-${randomUUID().slice(0, 8)}`, domains: body.domains ?? [], directory_url: body.directory_url, status: 'pending_challenges', http01_challenges: (body.domains ?? []).map((d) => ({ identifier: d, token: 'tok', key_authorization: 'tok.abc', path: '/.well-known/acme-challenge/tok' })), created_at: now(), updated_at: now() };
    acmeOrders.push(order);
    return send(201, order);
  }
  if (path === '/admin/tls/acme/accounts') return send(200, paginate([{ account_id: 'https://acme-v02.api.letsencrypt.org/acme/acct/123', directory_url: 'https://acme-v02.api.letsencrypt.org/directory', order_count: 2, certificate_count: 1, has_persisted_credentials: true, last_order_at: ago(10) }], url));
  const acmeOrderMatch = path.match(/^\/admin\/tls\/acme\/orders\/([^/]+)(\/finalize)?$/);
  if (acmeOrderMatch) {
    const order = acmeOrders.find((o) => o.id === acmeOrderMatch[1]);
    if (!order) return send(404, { error: 'not found' });
    if (acmeOrderMatch[2]) {
      order.status = 'valid';
      return send(200, { order, certificate: acmeCerts[0] });
    }
    if (method === 'DELETE') { acmeOrders.splice(acmeOrders.indexOf(order), 1); return send(200, null); }
    return send(200, order);
  }
  const renewMatch = path.match(/^\/admin\/tls\/acme\/renew\/([^/]+)$/);
  if (renewMatch) {
    const order = { id: `order-renew-${randomUUID().slice(0, 6)}`, certificate_id: renewMatch[1], domains: acmeCerts[0].domains, directory_url: acmeCerts[0].directory_url, status: 'processing', created_at: now(), updated_at: now() };
    acmeOrders.push(order);
    return send(201, order);
  }
  const managedMatch = path.match(/^\/admin\/tls\/(certificates|ca-bundles|crls|ocsp-responses|jwks)(?:\/([^/]+))?$/);
  if (managedMatch) {
    const [, collection, id] = managedMatch;
    const list = managedTls[collection];
    if (method === 'POST') {
      const kind = { certificates: 'certificate', 'ca-bundles': 'ca_bundle', crls: 'crl', 'ocsp-responses': 'ocsp_response', jwks: 'jwks' }[collection];
      const record = { id: body.id || randomUUID().slice(0, 8), name: body.name || body.id || 'unnamed', kind, source_uri: `managed://${collection}/${body.id || 'new'}`, subject: 'CN=uploaded.example.com', not_after: new Date(Date.now() + 90 * 86400000).toISOString(), byte_length: 2048, created_at: now(), updated_at: now() };
      list.push(record);
      return send(201, record);
    }
    const [status, payload] = crud(list, url, method, id, body, {}, ns);
    return send(status, payload);
  }

  /* backup / restore / batch */
  if (path === '/backup') {
    return send(200, {
      version: '1', ferrum_version: '1.4.2', exported_at: now(), source: 'database',
      counts: { proxies: proxies.length, consumers: consumers.length, plugin_configs: pluginConfigs.length, upstreams: upstreams.length, api_specs: apiSpecs.length, gateway_trust_bundles: 1 },
      proxies, consumers, plugin_configs: pluginConfigs, upstreams,
    });
  }
  if (path === '/restore') {
    return send(200, { restored: { proxies: (body.proxies ?? []).length, consumers: (body.consumers ?? []).length, plugin_configs: (body.plugin_configs ?? []).length, upstreams: (body.upstreams ?? []).length, api_specs: 0, gateway_trust_bundles: 0 } });
  }
  if (path === '/batch') {
    return send(201, { created: { proxies: (body.proxies ?? []).length, consumers: (body.consumers ?? []).length, plugin_configs: (body.plugin_configs ?? []).length, upstreams: (body.upstreams ?? []).length } });
  }

  /* namespaces & plugin registry */
  if (path === '/namespaces') {
    if (method === 'GET') {
      // Union of the durable registry and namespaces derived from resources.
      const derived = [...proxies, ...consumers, ...pluginConfigs, ...upstreams, ...apiSpecs]
        .map((r) => r.namespace)
        .filter(Boolean);
      const names = [...new Set([...namespaceRegistry.keys(), ...derived])].sort();
      return send(200, paginate(names, url));
    }
    if (method === 'POST') {
      const validationError = validateNamespaceBody(body, true);
      if (validationError) return send(400, { error: validationError });
      if (namespaceRegistry.has(body.name) || namespaceHasResources(body.name)) {
        return send(409, { error: `namespace "${body.name}" already exists` });
      }
      const record = { name: body.name, created_at: now(), updated_at: now() };
      const description = normalizeNamespaceDescription(body.description);
      if (description) record.description = description;
      namespaceRegistry.set(record.name, record);
      return send(201, record);
    }
    return send(405, { error: 'method not allowed' });
  }
  const namespaceMatch = path.match(/^\/namespaces\/([^/]+)$/);
  if (namespaceMatch) {
    const name = decodeURIComponent(namespaceMatch[1]);
    const existing = namespaceRegistry.get(name);
    if (method === 'GET') {
      if (existing) return send(200, existing);
      // Derived-only names get a synthesized record with observation timestamps.
      if (namespaceHasResources(name)) return send(200, { name, created_at: now(), updated_at: now() });
      return send(404, { error: 'not found' });
    }
    if (method === 'PUT') {
      if (!existing && !namespaceHasResources(name)) return send(404, { error: 'not found' });
      const validationError = validateNamespaceBody(body, false);
      if (validationError) return send(400, { error: validationError });
      const renaming = body.name !== undefined && body.name !== name;
      if (renaming && name === PROTECTED_NAMESPACE) {
        return send(409, { error: 'cannot rename a namespace this gateway is configured to serve (FERRUM_NAMESPACE / FERRUM_CP_NAMESPACES)' });
      }
      if (renaming && (namespaceRegistry.has(body.name) || namespaceHasResources(body.name))) {
        return send(409, { error: `namespace "${body.name}" already exists` });
      }
      // A derived-only namespace is materialized by the update.
      const record = existing ?? { name, created_at: now(), updated_at: now() };
      if ('description' in body) {
        const description = normalizeNamespaceDescription(body.description);
        if (description) record.description = description;
        else delete record.description;
      }
      if (renaming) {
        namespaceRegistry.delete(name);
        record.name = body.name;
        for (const resource of [...proxies, ...consumers, ...pluginConfigs, ...upstreams, ...apiSpecs]) {
          if (resource.namespace === name) resource.namespace = body.name;
        }
      }
      record.updated_at = now();
      namespaceRegistry.set(record.name, record);
      return send(200, record);
    }
    if (method === 'DELETE') {
      if (name === PROTECTED_NAMESPACE) {
        return send(409, { error: 'cannot delete a namespace this gateway is configured to serve (FERRUM_NAMESPACE / FERRUM_CP_NAMESPACES)' });
      }
      if (!existing) return send(404, { error: 'not found' });
      if (namespaceRegistry.size <= 1) return send(409, { error: 'cannot delete the last remaining namespace registry row' });
      if (namespaceHasResources(name) && url.searchParams.get('confirm') !== 'true') {
        return send(409, { error: `namespace "${name}" still has resources; pass confirm=true to cascade-delete` });
      }
      for (const list of [proxies, consumers, pluginConfigs, upstreams, apiSpecs]) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].namespace === name) list.splice(i, 1);
        }
      }
      namespaceRegistry.delete(name);
      return send(204, null);
    }
    return send(405, { error: 'method not allowed' });
  }
  if (path === '/plugins' && method === 'GET') return send(200, AVAILABLE_PLUGINS);

  /* core CRUD */
  const routes = [
    // The real gateway always returns a plugins association array on proxies;
    // default it on create so upstream-only proxies match that shape.
    [/^\/proxies(?:\/([^/]+))?$/, proxies, { plugins: [] }],
    [/^\/consumers(?:\/([^/]+))?$/, consumers],
    [/^\/plugins\/config(?:\/([^/]+))?$/, pluginConfigs],
    [/^\/upstreams(?:\/([^/]+))?$/, upstreams],
  ];
  for (const [pattern, list, defaults] of routes) {
    const match = path.match(pattern);
    if (match) {
      const [status, payload] = crud(list, url, method, match[1], body, defaults, ns);
      return send(status, payload);
    }
  }

  /* consumer credential endpoints — return the consumer */
  const credMatch = path.match(/^\/consumers\/([^/]+)\/credentials\/([^/]+)(?:\/(\d+))?$/);
  if (credMatch) {
    const consumer = consumers.find((c) => c.id === credMatch[1]);
    if (!consumer) return send(404, { error: 'not found' });
    if (method === 'DELETE') return credMatch[3] ? send(200, consumer) : send(204, null);
    return send(200, consumer);
  }

  send(404, { error: `mock: no handler for ${method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`Mock Ferrum Edge admin API listening on http://127.0.0.1:${PORT}`);
});
