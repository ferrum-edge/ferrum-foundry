import {
  codePointLength,
  MANIFEST_STRING_SAFETY_CAP,
  manifestDefaults,
  serviceManifestSchema,
} from './service-manifest-schema.js';
import type {
  ServiceManifestPluginPreview,
  ServiceManifestPreview,
  ServiceManifestProxyPreview,
  ServiceManifestTlsPreview,
  ServiceManifestUpstreamPreview,
} from '../shared/service-manifest.js';
export type { ServiceManifestPreview } from '../shared/service-manifest.js';

// Alloy's literal path rule (manifest.rs `valid_path`): RFC 3986 pchars and
// `/` only, minus `;`, `%`, `~` and `*`. Non-ASCII, spaces, query/fragment
// delimiters, templates and backslashes are refused by construction.
const LITERAL_PATH_PATTERN = /^\/[A-Za-z0-9\-._!$&'()+,=:@/]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const LOOPBACK_IPV4_SPELLING_PATTERN = /^127(?:\.[0-9]{1,3}){3}$/;
const PARSED_LOOPBACK_IPV4_PATTERN = /^127\.[0-9]+\.[0-9]+\.[0-9]+$/;
const PORT_DIGITS_PATTERN = /^[0-9]*$/;
const CLEARTEXT_SCHEME_PATTERN = /^http:\/\//i;
const AUTHORITY_END_PATTERN = /[/?#]/;
// Rust's str::trim: Unicode White_Space at either end (Edge trims the
// configured endpoint before screening it). Unlike String.prototype.trim it
// includes U+0085 and excludes U+FEFF.
const RUST_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// The endpoint Edge's otel_tracing screens and dials: the configured value
// trimmed (`optional_string_config`). The desired config keeps the value as
// Alloy writes it.
export function edgeOtelEndpoint(endpoint: string): string {
  // A linear scan from both ends (no regular expression, so no backtracking
  // on long whitespace runs). Every character in the set is in the BMP, so
  // UTF-16 code units suffice.
  let start = 0;
  let end = endpoint.length;
  while (start < end && RUST_WHITESPACE.has(endpoint.charCodeAt(start))) start += 1;
  while (end > start && RUST_WHITESPACE.has(endpoint.charCodeAt(end - 1))) end -= 1;
  return endpoint.slice(start, end);
}

// Edge's resource ID limit (Alloy EDGE_RESOURCE_ID_MAX_LENGTH).
export const EDGE_RESOURCE_ID_MAX_LENGTH = 254;

export const MANIFEST_BODY_LIMIT = 32 * 1024;
export const MANIFEST_RESPONSE_LIMIT = 16 * 1024;
export const TLS_PATH_REDACTION = '[REDACTED: TLS path metadata]';

export interface NormalizedManifest {
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
  // "gateway" is refused before normalization; see validatedManifest.
  auth: { mode?: 'none' | 'service' };
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
  return LITERAL_PATH_PATTERN.test(value) && !value.includes('//')
    && !value.split('/').some((part) => part === '.' || part === '..');
}

// Every resource ID Alloy derives from the proxy ID. The `otel_tracing` plugin
// is always generated (it removes caller trace context even without an
// exporter), so its suffix bounds the ID with no health check or correlation.
export function derivedResourceIds(manifest: NormalizedManifest): string[] {
  const id = manifest.gateway.proxy_id ?? manifest.service.name;
  return [
    ...(manifest.health ? [`${id}-upstream`] : []),
    ...(manifest.gateway.correlation_id ? [`${id}-correlation-id`] : []),
    `${id}-otel-tracing`,
  ];
}

// Edge's otel_tracing cleartext rule (`screen_cleartext_endpoint` with
// `is_loopback_ip_literal_endpoint`, src/plugins/utils/socket_host.rs): an
// `http://` exporter is admitted without `allow_plaintext` (which Alloy never
// writes) only when the parsed host is a loopback IP and the configured
// authority is spelled `127.d.d.d` (1-3 digit octets) or `[::1]`, with an
// optional all-digit port. Names such as `localhost` never qualify. Judged on
// the trimmed value, as Edge judges it.
export function admittedOtelEndpoint(configured: string): boolean {
  const endpoint = edgeOtelEndpoint(configured);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:' || !CLEARTEXT_SCHEME_PATTERN.test(endpoint)) return false;
  // WHATWG URL parsing (as Edge's url crate) normalizes an IPv4 literal to
  // dotted decimal and an IPv6 literal to its compressed bracketed form.
  if (url.hostname !== '[::1]' && !PARSED_LOOPBACK_IPV4_PATTERN.test(url.hostname)) return false;
  const rest = endpoint.slice('http://'.length);
  const end = rest.search(AUTHORITY_END_PATTERN);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.startsWith('[::1]')) {
    const after = authority.slice('[::1]'.length);
    return after === '' || (after.startsWith(':') && PORT_DIGITS_PATTERN.test(after.slice(1)));
  }
  const colon = authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (colon !== -1 && !PORT_DIGITS_PATTERN.test(authority.slice(colon + 1))) return false;
  return LOOPBACK_IPV4_SPELLING_PATTERN.test(host);
}

function safeStrings(value: unknown): boolean {
  if (typeof value === 'string') {
    // A safety cap before schema validation (which applies each field's own
    // maxLength), and no control characters anywhere. Both count code points;
    // a UTF-16 length within the cap is a fast path.
    return (value.length <= MANIFEST_STRING_SAFETY_CAP
      || codePointLength(value) <= MANIFEST_STRING_SAFETY_CAP)
      && !CONTROL_CHARACTER_PATTERN.test(value);
  }
  if (Array.isArray(value)) return value.every(safeStrings);
  // Property names too: an unknown key is refused here, before validation.
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([key, item]) => safeStrings(key) && safeStrings(item));
  }
  return true;
}

export function validatedManifest(body: unknown): NormalizedManifest | null {
  if (!safeStrings(body)) return null;
  const { schema, validator } = serviceManifestSchema();
  const result = validator.safeParse(body);
  if (!result.success) return null;
  const value = result.data as Record<string, unknown>;
  // Alloy's export refuses gateway authentication, which it cannot generate:
  // its configuration would let every request through unauthenticated.
  if ((value.auth as { mode?: string } | undefined)?.mode === 'gateway') return null;
  const manifest = manifestDefaults(schema, {
    ...value,
    timeouts: value.timeouts ?? {},
    gateway: value.gateway ?? {},
    auth: value.auth ?? {},
  }) as NormalizedManifest;
  const { api, gateway, health, agents } = manifest;
  if (derivedResourceIds(manifest).some((id) => id.length > EDGE_RESOURCE_ID_MAX_LENGTH)) {
    return null;
  }
  if (!literalPath(api.public_path) || !literalPath(api.service_base_path)
    || (health && !literalPath(health.path))) return null;
  if (agents?.endpoint_path) {
    const prefix = `${api.public_path.replace(TRAILING_SLASHES_PATTERN, '')}/`;
    if (!literalPath(agents.endpoint_path) || !agents.endpoint_path.startsWith(prefix)
      || agents.endpoint_path.length === prefix.length) return null;
  }
  // Even without fetching, query strings can contain credentials. This local
  // preview supports only a literal credential-free OTLP location, and only
  // one Edge would export to: https://, or cleartext to a loopback IP literal.
  if (gateway.otel_endpoint !== undefined) {
    if (!admittedOtelEndpoint(gateway.otel_endpoint)) return null;
    const endpoint = new URL(edgeOtelEndpoint(gateway.otel_endpoint));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  }
  // schema_version is a contract field, never an invented schemaMajor field.
  return manifest;
}

export function createManifestPreview(manifest: NormalizedManifest): ServiceManifestPreview {
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
  // Always generated, as Alloy does: only otel_tracing removes a caller's
  // traceparent/tracestate. Without an exporter it runs propagation-only with
  // trace generation off, so it exports nothing and forwards no trace context;
  // the sampling ratio applies only to an exporter.
  plugins.push({
    id: `${id}-otel-tracing`, plugin_name: 'otel_tracing', namespace,
    scope: 'proxy', proxy_id: id, enabled: true,
    config: gateway.otel_endpoint !== undefined ? {
      endpoint: gateway.otel_endpoint,
      service_name: `ferrum-edge-${namespace}`,
      trace_context_trust: 'untrusted',
      include_url_path: false,
      ...(gateway.otel_root_sampling_ratio !== undefined ? {
        root_sampling: 'ratio', root_sampling_ratio: gateway.otel_root_sampling_ratio,
      } : {}),
    } : {
      service_name: `ferrum-edge-${namespace}`,
      trace_context_trust: 'untrusted',
      generate_trace_id: false,
      include_url_path: false,
    },
  });
  const proxy: ServiceManifestProxyPreview = {
    id, name: service.name, namespace, listen_path: api.public_path,
    backend_scheme: upstream.scheme, strip_listen_path: api.strip_public_path,
    ...(api.service_base_path !== '/' ? {
      backend_path: api.service_base_path.replace(TRAILING_SLASHES_PATTERN, ''),
    } : {}),
    backend_connect_timeout_ms: timeouts.connect_ms,
    backend_read_timeout_ms: timeouts.read_ms,
    backend_write_timeout_ms: timeouts.write_ms,
    labels: { 'generated-by': 'ferrum-alloy' },
    plugins: plugins.map((plugin) => ({ plugin_config_id: plugin.id })),
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
      traceExporter: gateway.otel_endpoint !== undefined ? 'otlp' : 'none',
      openapiDeclared: api.openapi !== undefined,
      agents: agents ? {
        enabled: agents.enabled,
        endpointPath: agents.endpoint_path ?? `${api.public_path.replace(TRAILING_SLASHES_PATTERN, '')}/mcp`,
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
