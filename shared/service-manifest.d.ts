export interface ServiceManifestTlsPreview {
  backend_tls_verify_server_cert?: true;
  backend_tls_client_cert_path?: '[REDACTED: TLS path metadata]';
  backend_tls_client_key_path?: '[REDACTED: TLS path metadata]';
  backend_tls_server_ca_cert_path?: '[REDACTED: TLS path metadata]';
}

export interface ServiceManifestCorrelationPluginPreview {
  id: string;
  plugin_name: 'correlation_id';
  namespace: string;
  scope: 'proxy';
  proxy_id: string;
  enabled: true;
  config: { header_name: 'x-request-id'; echo_downstream: true };
}

export interface ServiceManifestOtelPluginPreview {
  id: string;
  plugin_name: 'otel_tracing';
  namespace: string;
  scope: 'proxy';
  proxy_id: string;
  enabled: true;
  config: {
    endpoint: string;
    service_name: string;
    trace_context_trust: 'untrusted';
    include_url_path: false;
    root_sampling?: 'ratio';
    root_sampling_ratio?: number;
  };
}

export type ServiceManifestPluginPreview =
  | ServiceManifestCorrelationPluginPreview
  | ServiceManifestOtelPluginPreview;

export interface ServiceManifestProxyPreview extends ServiceManifestTlsPreview {
  id: string;
  name: string;
  namespace: string;
  listen_path: string;
  backend_scheme: 'http' | 'https';
  strip_listen_path: boolean;
  backend_path?: string;
  backend_connect_timeout_ms: number;
  backend_read_timeout_ms: number;
  backend_write_timeout_ms: number;
  labels: { 'generated-by': 'ferrum-alloy' };
  plugins?: { plugin_config_id: string }[];
  upstream_id?: string;
  backend_host?: string;
  backend_port?: number;
}

export interface ServiceManifestUpstreamPreview extends ServiceManifestTlsPreview {
  id: string;
  name: string;
  namespace: string;
  algorithm: 'round_robin';
  targets: [{ host: string; port: number; weight: 1 }];
  health_checks: {
    active: {
      probe_type: 'http';
      http_path: string;
      interval_seconds: number;
      timeout_ms: number;
      healthy_status_codes: [200];
      use_tls: boolean;
    };
  };
  labels: { 'generated-by': 'ferrum-alloy' };
}

export interface ServiceManifestPreview {
  readOnly: true;
  summary: {
    service: string;
    namespace: string;
    protocols: string[];
    authMode: 'none' | 'gateway' | 'service' | 'unspecified';
    openapiDeclared: boolean;
    agents: {
      enabled: boolean;
      endpointPath: string;
      namespace: string;
    } | null;
    tlsPathFields: string[];
  };
  desired: {
    proxy: ServiceManifestProxyPreview;
    upstream: ServiceManifestUpstreamPreview | null;
    plugin_configs: ServiceManifestPluginPreview[];
  };
  warnings: string[];
}
