import { manifestDefaults, manifestSchema, manifestValidator } from './service-manifest-schema.js';
import type {
  ServiceManifestPluginPreview,
  ServiceManifestPreview,
  ServiceManifestProxyPreview,
  ServiceManifestTlsPreview,
  ServiceManifestUpstreamPreview,
} from '../shared/service-manifest.js';
export type { ServiceManifestPreview } from '../shared/service-manifest.js';

export const MANIFEST_BODY_LIMIT = 32 * 1024;
export const MANIFEST_RESPONSE_LIMIT = 16 * 1024;
export const TLS_PATH_REDACTION = '[REDACTED: TLS path metadata]';

interface Manifest {
  service: { name: string };
  api: {
    public_path: string;
    service_base_path: string;
    strip_public_path: boolean;
    openapi?: string;
  };
  upstream: {
    host: string;
    port: number;
    scheme: 'http' | 'https';
    protocols: string[];
    gateway_client_cert_path?: string;
    gateway_client_key_path?: string;
    server_ca_path?: string;
  };
  health?: { path: string; interval_seconds: number; timeout_ms: number };
  timeouts: { connect_ms: number; read_ms: number; write_ms: number };
  gateway: {
    namespace: string;
    proxy_id?: string;
    correlation_id: boolean;
    otel_endpoint?: string;
    otel_root_sampling_ratio?: number;
  };
  auth: { mode?: 'none' | 'gateway' | 'service' };
  agents?: { enabled: boolean; endpoint_path?: string; namespace?: string };
}

// Bound nesting before JSON.parse or recursive schema validation. Quoted
// braces and escaped quotes do not count; malformed JSON still fails parsing.
export function parseManifestJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > MANIFEST_BODY_LIMIT) throw new Error('Manifest budget exceeded');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > 8) throw new Error('Manifest nesting budget exceeded');
    } else if (character === '}' || character === ']') depth -= 1;
  }
  return JSON.parse(raw) as unknown;
}

function literalPath(value: string): boolean {
  return value.startsWith('/') && !/[{}*~ ?#;%\\]/.test(value) && !value.includes('//')
    && !value.split('/').some((part) => part === '.' || part === '..');
}

function safeStrings(value: unknown): boolean {
  if (typeof value === 'string') {
    // Bound presentation strings and reject control characters.
    // eslint-disable-next-line no-control-regex
    return value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
  }
  if (Array.isArray(value)) return value.every(safeStrings);
  if (value && typeof value === 'object') return Object.values(value).every(safeStrings);
  return true;
}

export function validatedManifest(body: unknown): Manifest | null {
  if (!safeStrings(body)) return null;
  const result = manifestValidator.safeParse(body);
  if (!result.success) return null;
  const value = result.data as Record<string, unknown>;
  const manifest = manifestDefaults(manifestSchema, {
    ...value,
    timeouts: value.timeouts ?? {},
    gateway: value.gateway ?? {},
    auth: value.auth ?? {},
  }) as Manifest;
  const { api, gateway, health, agents } = manifest;
  const id = gateway.proxy_id ?? manifest.service.name;
  const suffixes = [
    ...(health ? ['-upstream'] : []),
    ...(gateway.correlation_id ? ['-correlation-id'] : []),
    ...(gateway.otel_endpoint ? ['-otel-tracing'] : []),
  ];
  if (suffixes.some((suffix) => id.length + suffix.length > 254)) return null;
  if (!literalPath(api.public_path) || !literalPath(api.service_base_path)
    || (health && !literalPath(health.path))) return null;
  if (agents?.endpoint_path) {
    const prefix = `${api.public_path.replace(/\/+$/, '')}/`;
    if (!literalPath(agents.endpoint_path) || !agents.endpoint_path.startsWith(prefix)
      || agents.endpoint_path.length === prefix.length) return null;
  }
  // Even without fetching, query strings can contain credentials. This local
  // preview supports only a literal credential-free OTLP location.
  if (gateway.otel_endpoint) {
    try {
      const endpoint = new URL(gateway.otel_endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    } catch {
      return null;
    }
  }
  // schema_version is a contract field, never an invented schemaMajor field.
  return manifest;
}

export function createManifestPreview(manifest: Manifest): ServiceManifestPreview {
  const { service, api, upstream, gateway, timeouts, health, agents } = manifest;
  const id = gateway.proxy_id ?? service.name;
  const namespace = gateway.namespace;
  const tls: ServiceManifestTlsPreview = upstream.scheme === 'https'
    ? { backend_tls_verify_server_cert: true }
    : {};
  const tlsPathFields: string[] = [];
  for (const [source, target] of [
    ['gateway_client_cert_path', 'backend_tls_client_cert_path'],
    ['gateway_client_key_path', 'backend_tls_client_key_path'],
    ['server_ca_path', 'backend_tls_server_ca_cert_path'],
  ] as const) {
    if (upstream[source] !== undefined) {
      tls[target] = TLS_PATH_REDACTION;
      tlsPathFields.push(target);
    }
  }
  const plugins: ServiceManifestPluginPreview[] = [];
  if (gateway.correlation_id) {
    plugins.push({
      id: `${id}-correlation-id`, plugin_name: 'correlation_id', namespace,
      scope: 'proxy', proxy_id: id, enabled: true,
      config: { header_name: 'x-request-id', echo_downstream: true },
    });
  }
  if (gateway.otel_endpoint) {
    plugins.push({
      id: `${id}-otel-tracing`, plugin_name: 'otel_tracing', namespace,
      scope: 'proxy', proxy_id: id, enabled: true,
      config: {
        endpoint: gateway.otel_endpoint,
        service_name: `ferrum-edge-${namespace}`,
        trace_context_trust: 'untrusted',
        include_url_path: false,
        ...(gateway.otel_root_sampling_ratio !== undefined ? {
          root_sampling: 'ratio', root_sampling_ratio: gateway.otel_root_sampling_ratio,
        } : {}),
      },
    });
  }
  const proxy: ServiceManifestProxyPreview = {
    id, name: service.name, namespace, listen_path: api.public_path,
    backend_scheme: upstream.scheme, strip_listen_path: api.strip_public_path,
    ...(api.service_base_path !== '/' ? {
      backend_path: api.service_base_path.replace(/\/+$/, ''),
    } : {}),
    backend_connect_timeout_ms: timeouts.connect_ms,
    backend_read_timeout_ms: timeouts.read_ms,
    backend_write_timeout_ms: timeouts.write_ms,
    labels: { 'generated-by': 'ferrum-alloy' },
    ...(plugins.length ? {
      plugins: plugins.map((plugin) => ({ plugin_config_id: plugin.id })),
    } : {}),
  };
  let desiredUpstream: ServiceManifestUpstreamPreview | null = null;
  if (health) {
    proxy.upstream_id = `${id}-upstream`;
    desiredUpstream = {
      id: `${id}-upstream`, name: `${service.name} service`, namespace,
      algorithm: 'round_robin',
      targets: [{ host: upstream.host, port: upstream.port, weight: 1 }],
      health_checks: { active: {
        probe_type: 'http', http_path: health.path, interval_seconds: health.interval_seconds,
        timeout_ms: health.timeout_ms,
        healthy_status_codes: [200],
        use_tls: upstream.scheme === 'https',
      } },
      ...tls,
      labels: { 'generated-by': 'ferrum-alloy' },
    };
  } else {
    Object.assign(proxy, { backend_host: upstream.host, backend_port: upstream.port }, tls);
  }
  return {
    readOnly: true as const,
    summary: {
      service: service.name, namespace, protocols: upstream.protocols,
      authMode: manifest.auth.mode ?? 'unspecified',
      openapiDeclared: api.openapi !== undefined,
      agents: agents ? {
        enabled: agents.enabled,
        endpointPath: agents.endpoint_path ?? `${api.public_path.replace(/\/+$/, '')}/mcp`,
        namespace: agents.namespace ?? service.name,
      } : null,
      tlsPathFields,
    },
    desired: { proxy, upstream: desiredUpstream, plugin_configs: plugins },
    warnings: [
      'Preview only. Review in the current editors; normal saves require separate approval.',
      'TLS paths are redacted metadata, never read or resolved; runtime TLS is not qualified.',
      'Protocols, auth, OpenAPI and agents are informational; no auth policy or MCP tools installed.',
      'No manifest URL, OpenAPI file or telemetry endpoint is fetched. No gateway request is made.',
    ],
  };
}
