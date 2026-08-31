import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { signAdminJwt } from "../shared/admin-jwt.js";

const CONTRACT_REVISION = "50e65b5798555209114cbe08ab2d011b3896ad00";

const backendPorts = [9101, 9102, 9103, 9104, 9105];
const algorithms = [
  "round_robin",
  "weighted_round_robin",
  "least_connections",
  "least_latency",
  "consistent_hashing",
  "random",
];

const upstreamNames = [
  "catalog",
  "orders",
  "inventory",
  "shipping",
  "billing",
  "identity",
  "profiles",
  "search",
  "notifications",
  "reporting",
  "analytics",
  "recommendations",
  "ledger",
  "fulfillment",
  "support",
  "pricing",
  "partner-sync",
  "sandbox",
];

const proxyPlans = [
  { slug: "catalog", auth: "key", group: "commerce" },
  { slug: "orders", auth: "key", group: "commerce" },
  { slug: "inventory", auth: "key", group: "warehouse" },
  { slug: "shipping", auth: "key", group: "warehouse" },
  { slug: "billing", auth: "key", group: "finance" },
  { slug: "identity", auth: "basic", group: "ops" },
  { slug: "profiles", auth: "basic", group: "ops" },
  { slug: "search", auth: "basic", group: "ops" },
  { slug: "notifications", auth: "basic", group: "ops" },
  { slug: "reporting", auth: "jwt", group: "mobile" },
  { slug: "analytics", auth: "jwt", group: "mobile" },
  { slug: "recommendations", auth: "jwt", group: "mobile" },
  { slug: "ledger", auth: "jwt", group: "finance" },
  { slug: "fulfillment", auth: "multi", group: "partner" },
  { slug: "support", auth: "multi", group: "partner" },
  { slug: "pricing", auth: "public", group: "public" },
  { slug: "partner-sync", auth: "public", group: "public" },
  { slug: "sandbox", auth: "mock", group: "public" },
];

function isoNow() {
  return new Date().toISOString();
}

function parseAudience(value) {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries?.length) return undefined;
  return entries.length === 1 ? entries[0] : [...new Set(entries)];
}

function parseHttpOrigin(value, name, fallback) {
  const raw = value?.trim() || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

function parseBackendHost(value) {
  const host = value?.trim() || "127.0.0.1";
  const validHostname = host.length <= 253 && host.split(".").every((label) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  ));
  if (!isIP(host) && !validHostname) {
    throw new Error("FERRUM_DEMO_BACKEND_HOST must be an IP address or DNS hostname without a port");
  }
  return host;
}

export function readSeedConfig(env = process.env) {
  const jwtSecret = env.FERRUM_JWT_SECRET?.trim();
  if (!jwtSecret) throw new Error("FERRUM_JWT_SECRET is required; the demo seeder has no fallback signing key");

  return {
    adminUrl: parseHttpOrigin(env.FERRUM_ADMIN_URL, "FERRUM_ADMIN_URL", "http://127.0.0.1:9000"),
    proxyBaseUrl: parseHttpOrigin(
      env.FERRUM_DEMO_PROXY_URL,
      "FERRUM_DEMO_PROXY_URL",
      "http://127.0.0.1:8000",
    ),
    backendHost: parseBackendHost(env.FERRUM_DEMO_BACKEND_HOST),
    jwtSecret,
    jwtIssuer: env.FERRUM_JWT_ISSUER?.trim() || "ferrum-edge",
    jwtAudience: parseAudience(env.FERRUM_JWT_AUDIENCE),
    namespace: env.FERRUM_NAMESPACE?.trim() || "ferrum-foundry-demo",
    manifestPath: env.FERRUM_DEMO_MANIFEST?.trim() || "/tmp/ferrum-foundry-demo-manifest.json",
    destructiveConfirmation: env.FERRUM_DEMO_CONFIRM_TARGET?.trim(),
  };
}

export async function adminToken(config, options = {}) {
  return signAdminJwt({
    secret: config.jwtSecret,
    issuer: config.jwtIssuer,
    subject: "ferrum-foundry-demo-seeder",
    role: "admin",
    audience: config.jwtAudience,
    namespaces: [config.namespace],
    ttlSeconds: 900,
    ...options,
  });
}

async function adminRequest(config, path, options = {}) {
  const token = await adminToken(config);
  const response = await fetch(`${config.adminUrl}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-ferrum-namespace": config.namespace,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.errors) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return body;
}

function makeConsumers(now) {
  const keyConsumers = Array.from({ length: 6 }, (_, index) => ({
    id: `demo-key-consumer-${index + 1}`,
    username: `demo-key-${index + 1}`,
    custom_id: `key-app-${index + 1}`,
    credentials: { keyauth: [{ key: `ff-key-${index + 1}` }] },
    acl_groups: ["demo", index < 3 ? "commerce" : "warehouse", index === 4 ? "finance" : "edge"],
    created_at: now,
    updated_at: now,
  }));

  const basicConsumers = Array.from({ length: 6 }, (_, index) => ({
    id: `demo-basic-consumer-${index + 1}`,
    username: `demo-basic-${index + 1}`,
    custom_id: `ops-user-${index + 1}`,
    credentials: { basicauth: [{ password: `basic-pass-${index + 1}` }] },
    acl_groups: ["demo", "ops", index % 2 === 0 ? "support" : "identity"],
    created_at: now,
    updated_at: now,
  }));

  const jwtConsumers = Array.from({ length: 6 }, (_, index) => ({
    id: `demo-jwt-consumer-${index + 1}`,
    username: `demo-jwt-${index + 1}`,
    custom_id: `mobile-user-${index + 1}`,
    credentials: { jwt: [{ secret: `jwt-demo-consumer-${index + 1}-secret-at-least-32-characters` }] },
    acl_groups: ["demo", index < 3 ? "mobile" : "finance", "partner"],
    created_at: now,
    updated_at: now,
  }));

  return [...keyConsumers, ...basicConsumers, ...jwtConsumers];
}

function makeUpstreams(now, backendHost) {
  return upstreamNames.map((name, index) => {
    const algorithm = algorithms[index % algorithms.length];
    const upstream = {
      id: `demo-upstream-${name}`,
      name: `${name} service pool`,
      targets: [0, 1, 2].map((offset) => ({
        host: backendHost,
        port: backendPorts[(index + offset) % backendPorts.length],
        weight: offset + 1,
        path: `/${name}`,
        tags: {
          service: name,
          zone: `az-${String.fromCharCode(97 + offset)}`,
          version: `v${(index % 3) + 1}`,
        },
      })),
      algorithm,
      health_checks: {
        active: {
          http_path: "/health",
          interval_seconds: 10,
          timeout_ms: 1000,
          healthy_threshold: 2,
          unhealthy_threshold: 3,
          healthy_status_codes: [200],
        },
        passive: {
          unhealthy_status_codes: [500, 502, 503, 504],
          unhealthy_threshold: 3,
          unhealthy_window_seconds: 30,
          healthy_after_seconds: 20,
        },
      },
      created_at: now,
      updated_at: now,
    };

    if (algorithm === "consistent_hashing") {
      upstream.hash_on = index % 2 === 0 ? "header:x-demo-user" : "cookie:ff_demo_session";
      upstream.hash_on_cookie_config = {
        path: "/",
        ttl_seconds: 1800,
        http_only: true,
        secure: false,
        same_site: "Lax",
      };
    }

    return upstream;
  });
}

function globalPluginConfigs(now) {
  return [
    {
      id: "demo-global-prometheus",
      plugin_name: "prometheus_metrics",
      scope: "global",
      enabled: true,
      config: {
        render_cache_ttl_seconds: 1,
        stale_entry_ttl_seconds: 3600,
        cache_invalidation_min_age_ms: 250,
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-stdout",
      plugin_name: "stdout_logging",
      scope: "global",
      enabled: true,
      config: {},
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-correlation",
      plugin_name: "correlation_id",
      scope: "global",
      enabled: true,
      config: { header_name: "X-Correlation-ID", echo_downstream: true },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-cors",
      plugin_name: "cors",
      scope: "global",
      enabled: true,
      config: {
        allowed_origins: ["http://localhost:5173", "http://localhost:8000"],
        allowed_methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowed_headers: ["Accept", "Authorization", "Content-Type", "X-API-Key", "X-Demo-User"],
        exposed_headers: ["X-Correlation-ID", "X-Demo-Response"],
        max_age: 300,
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-compression",
      plugin_name: "compression",
      scope: "global",
      enabled: true,
      config: {
        algorithms: ["gzip", "br"],
        min_content_length: 128,
        content_types: ["application/json", "text/plain"],
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-request-transform",
      plugin_name: "request_transformer",
      scope: "global",
      enabled: true,
      config: {
        rules: [
          { operation: "add", target: "header", key: "X-Demo-Gateway", value: "ferrum-foundry" },
        ],
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-response-transform",
      plugin_name: "response_transformer",
      scope: "global",
      enabled: true,
      config: {
        rules: [
          { operation: "add", target: "header", key: "X-Demo-Response", value: "seeded" },
        ],
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-request-size",
      plugin_name: "request_size_limiting",
      scope: "global",
      enabled: true,
      config: { max_bytes: 262144 },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-response-size",
      plugin_name: "response_size_limiting",
      scope: "global",
      enabled: true,
      config: { max_bytes: 1048576, require_buffered_check: false },
      created_at: now,
      updated_at: now,
    },
    {
      id: "demo-global-bot-detection",
      plugin_name: "bot_detection",
      scope: "global",
      enabled: true,
      config: {
        blocked_patterns: ["BadBot", "sqlmap"],
        allow_list: ["FerrumDemoClient"],
        allow_missing_user_agent: true,
      },
      created_at: now,
      updated_at: now,
    },
  ];
}

function authPluginForProxy(plan, now) {
  const proxyId = `demo-proxy-${plan.slug}`;
  if (plan.auth === "key") {
    return [{
      id: `${proxyId}-key-auth`,
      plugin_name: "key_auth",
      scope: "proxy",
      proxy_id: proxyId,
      enabled: true,
      config: { key_location: "header:X-API-Key" },
      created_at: now,
      updated_at: now,
    }];
  }
  if (plan.auth === "basic") {
    return [{
      id: `${proxyId}-basic-auth`,
      plugin_name: "basic_auth",
      scope: "proxy",
      proxy_id: proxyId,
      enabled: true,
      config: {},
      created_at: now,
      updated_at: now,
    }];
  }
  if (plan.auth === "jwt") {
    return [{
      id: `${proxyId}-jwt-auth`,
      plugin_name: "jwt_auth",
      scope: "proxy",
      proxy_id: proxyId,
      enabled: true,
      config: { token_lookup: "header:Authorization", consumer_claim_field: "sub" },
      created_at: now,
      updated_at: now,
    }];
  }
  if (plan.auth === "multi") {
    return [
      {
        id: `${proxyId}-jwt-auth`,
        plugin_name: "jwt_auth",
        scope: "proxy",
        proxy_id: proxyId,
        enabled: true,
        config: { token_lookup: "header:Authorization", consumer_claim_field: "sub" },
        created_at: now,
        updated_at: now,
      },
      {
        id: `${proxyId}-key-auth`,
        plugin_name: "key_auth",
        scope: "proxy",
        proxy_id: proxyId,
        enabled: true,
        config: { key_location: "header:X-API-Key" },
        created_at: now,
        updated_at: now,
      },
    ];
  }
  return [];
}

function makeProxyScopedPluginConfigs(now) {
  return proxyPlans.flatMap((plan) => {
    const proxyId = `demo-proxy-${plan.slug}`;
    const pluginConfigs = [
      ...authPluginForProxy(plan, now),
      {
        id: `${proxyId}-rate-limit`,
        plugin_name: "rate_limiting",
        scope: "proxy",
        proxy_id: proxyId,
        enabled: true,
        config: {
          limit_by: ["key", "basic", "jwt", "multi"].includes(plan.auth) ? "consumer" : "ip",
          expose_headers: true,
          limits: [{
            scope: "default",
            requests_per_second: 400,
            requests_per_minute: 20000,
          }],
          sync_mode: "local",
        },
        created_at: now,
        updated_at: now,
      },
    ];

    if (["key", "basic", "jwt", "multi"].includes(plan.auth)) {
      pluginConfigs.push({
        id: `${proxyId}-acl`,
        plugin_name: "access_control",
        scope: "proxy",
        proxy_id: proxyId,
        enabled: true,
        config: {
          allowed_groups: [plan.group, "demo"],
          disallowed_groups: ["blocked"],
        },
        created_at: now,
        updated_at: now,
      });
    }

    if (plan.auth === "mock") {
      pluginConfigs.push({
        id: `${proxyId}-response-mock`,
        plugin_name: "response_mock",
        scope: "proxy",
        proxy_id: proxyId,
        enabled: true,
        config: {
          rules: [
            {
              method: "GET",
              path: "/fixtures",
              status_code: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                service: "sandbox",
                source: "response_mock",
                records: [{ id: "fixture-1" }, { id: "fixture-2" }],
              }),
              delay_ms: 15,
            },
          ],
          passthrough_on_no_match: true,
        },
        created_at: now,
        updated_at: now,
      });
    }

    return pluginConfigs;
  });
}

function makeProxies(now, backendHost) {
  return proxyPlans.map((plan) => {
    const proxyId = `demo-proxy-${plan.slug}`;
    const upstreamId = `demo-upstream-${plan.slug}`;
    const pluginIds = makeProxyScopedPluginConfigs(now)
      .filter((pluginConfig) => pluginConfig.proxy_id === proxyId)
      .map((pluginConfig) => ({ plugin_config_id: pluginConfig.id }));

    return {
      id: proxyId,
      name: `${plan.slug.replace(/-/g, " ")} edge route`,
      listen_path: `/demo/${plan.slug}`,
      hosts: [],
      backend_scheme: "http",
      backend_host: backendHost,
      backend_port: backendPorts[0],
      strip_listen_path: true,
      preserve_host_header: false,
      backend_connect_timeout_ms: 1500,
      backend_read_timeout_ms: 5000,
      backend_write_timeout_ms: 5000,
      backend_tls_verify_server_cert: true,
      auth_mode: plan.auth === "multi" ? "multi" : "single",
      plugins: pluginIds,
      upstream_id: upstreamId,
      frontend_tls: false,
      passthrough: false,
      udp_idle_timeout_seconds: 60,
      allowed_methods: ["GET", "POST", "OPTIONS"],
      allowed_ws_origins: ["http://localhost:5173", "http://localhost:8000"],
      response_body_mode: plan.slug === "analytics" ? "buffer" : "stream",
      pool_idle_timeout_seconds: 45,
      pool_enable_http_keep_alive: true,
      pool_tcp_keepalive_seconds: 30,
      circuit_breaker: {
        failure_threshold: 5,
        success_threshold: 2,
        timeout_seconds: 20,
        failure_status_codes: [500, 502, 503, 504],
        half_open_max_requests: 2,
        trip_on_connection_errors: true,
      },
      retry: {
        max_retries: 1,
        retryable_status_codes: [502, 503, 504],
        retryable_methods: ["GET"],
        backoff: { fixed: { delay_ms: 25 } },
        retry_on_connect_failure: true,
      },
      created_at: now,
      updated_at: now,
    };
  });
}

function buildManifest(proxyBaseUrl) {
  const keyConsumers = Array.from({ length: 6 }, (_, index) => ({
    username: `demo-key-${index + 1}`,
    key: `ff-key-${index + 1}`,
  }));
  const basicConsumers = Array.from({ length: 6 }, (_, index) => ({
    username: `demo-basic-${index + 1}`,
    password: `basic-pass-${index + 1}`,
  }));
  const jwtConsumers = Array.from({ length: 6 }, (_, index) => ({
    username: `demo-jwt-${index + 1}`,
    secret: `jwt-demo-consumer-${index + 1}-secret-at-least-32-characters`,
  }));

  return {
    generated_at: new Date().toISOString(),
    proxy_base_url: proxyBaseUrl,
    key_consumers: keyConsumers,
    basic_consumers: basicConsumers,
    jwt_consumers: jwtConsumers,
    routes: proxyPlans.map((plan) => ({
      path: `/demo/${plan.slug}`,
      auth: plan.auth,
      group: plan.group,
    })),
  };
}

export function buildRestorePayload(now = isoNow(), { backendHost = "127.0.0.1" } = {}) {
  const consumers = makeConsumers(now);
  const upstreams = makeUpstreams(now, backendHost);
  const proxyScopedPluginConfigs = makeProxyScopedPluginConfigs(now);
  const proxies = makeProxies(now, backendHost);
  const pluginConfigs = [
    ...globalPluginConfigs(now),
    ...proxyScopedPluginConfigs,
  ];

  return {
    version: "1",
    ferrum_version: `contract-${CONTRACT_REVISION}`,
    exported_at: now,
    source: "database",
    counts: {
      consumers: consumers.length,
      upstreams: upstreams.length,
      proxies: proxies.length,
      plugin_configs: pluginConfigs.length,
      api_specs: 0,
      gateway_trust_bundles: 0,
    },
    consumers,
    upstreams,
    proxies,
    plugin_configs: pluginConfigs,
    api_specs: { section_version: "2", items: [] },
  };
}

export async function runSeed(config = readSeedConfig()) {
  const destructiveTarget = `${config.adminUrl}#${config.namespace}`;
  if (config.destructiveConfirmation !== destructiveTarget) {
    throw new Error(
      `Refusing to replace namespace ${JSON.stringify(config.namespace)}. `
      + `FERRUM_DEMO_CONFIRM_TARGET must exactly equal ${JSON.stringify(destructiveTarget)}.`,
    );
  }

  const restorePayload = buildRestorePayload(undefined, { backendHost: config.backendHost });
  const restored = await adminRequest(config, "/restore?confirm=true", {
    method: "POST",
    body: JSON.stringify(restorePayload),
  });

  const manifest = buildManifest(config.proxyBaseUrl);
  const manifestFd = openSync(
    config.manifestPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(manifestFd, 0o600);
    writeFileSync(manifestFd, JSON.stringify(manifest, null, 2));
  } finally {
    closeSync(manifestFd);
  }

  return {
    restored,
    manifest_path: config.manifestPath,
    namespace: config.namespace,
    counts: restorePayload.counts,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Demo seeding failed");
      process.exitCode = 1;
    });
}
