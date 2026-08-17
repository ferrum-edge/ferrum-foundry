/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy create / edit form                         */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleSection } from "./CollapsibleSection";
import type {
  Proxy,
  ProxyCreate,
  CircuitBreakerConfig,
  RetryConfig,
  BackoffStrategy,
} from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ProxyFormProps {
  initialData?: Proxy;
  onSubmit: (data: ProxyCreate) => Promise<void>;
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wire-level backend schemes. gRPC and WebSocket are detected per-request
 * by the gateway, so a single http/https proxy serves REST, gRPC, and
 * WebSocket traffic on the same backend pool.
 */
const BACKEND_SCHEMES: { value: NonNullable<Proxy["backend_scheme"]>; label: string }[] = [
  { value: "http", label: "HTTP (REST / gRPC / WebSocket)" },
  { value: "https", label: "HTTPS (REST / gRPC / WebSocket, auto H2/H3)" },
  { value: "tcp", label: "TCP (raw stream)" },
  { value: "tcps", label: "TCP + TLS (stream)" },
  { value: "udp", label: "UDP (datagram)" },
  { value: "dtls", label: "DTLS (encrypted datagram)" },
];

const ALL_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
] as const;

/* ------------------------------------------------------------------ */
/*  Helper: Tag Input                                                  */
/* ------------------------------------------------------------------ */

function TagInput({
  label,
  values,
  onChange,
  placeholder = "Type and press Enter",
  helpText,
  parseAsNumber = false,
}: {
  label?: string;
  values: (string | number)[];
  onChange: (values: (string | number)[]) => void;
  placeholder?: string;
  helpText?: string;
  parseAsNumber?: boolean;
}) {
  const [input, setInput] = useState("");

  const addTags = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const newValues = parts
      .map((p) => (parseAsNumber ? Number(p) : p))
      .filter((v) => {
        if (parseAsNumber && isNaN(v as number)) return false;
        return !values.includes(v);
      });
    if (newValues.length > 0) {
      onChange([...values, ...newValues]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(input);
      setInput("");
    }
    if (e.key === "Backspace" && input === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const handleBlur = () => {
    if (input.trim()) {
      addTags(input);
      setInput("");
    }
  };

  const removeTag = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="text-text-secondary text-sm font-medium">{label}</span>
      )}
      <div className="flex flex-wrap gap-1.5 bg-bg-input border border-border rounded-lg px-3 py-2 focus-within:border-orange focus-within:ring-1 focus-within:ring-orange/30 transition-colors duration-150">
        {values.map((v, i) => (
          <Badge key={`${v}-${i}`} variant="default">
            <span className="flex items-center gap-1">
              {String(v)}
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="text-text-muted hover:text-text-primary cursor-pointer"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </Badge>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={values.length === 0 ? placeholder : ""}
          className="bg-transparent text-text-primary text-sm outline-none flex-1 min-w-[80px] placeholder:text-text-muted"
        />
      </div>
      {helpText && <p className="text-text-muted text-xs">{helpText}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helper: Checkbox group for methods                                 */
/* ------------------------------------------------------------------ */

function MethodCheckboxGroup({
  label,
  selected,
  onChange,
  options,
}: {
  label: string;
  selected: string[];
  onChange: (selected: string[]) => void;
  options: readonly string[];
}) {
  const toggle = (method: string) => {
    if (selected.includes(method)) {
      onChange(selected.filter((m) => m !== method));
    } else {
      onChange([...selected, method]);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-text-secondary text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((method) => (
          <label
            key={method}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer transition-colors ${
              selected.includes(method)
                ? "bg-orange/15 text-orange-light border-orange/30"
                : "bg-transparent text-text-secondary border-border hover:border-border-hover"
            }`}
          >
            <input
              type="checkbox"
              checked={selected.includes(method)}
              onChange={() => toggle(method)}
              className="sr-only"
            />
            {method}
          </label>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helper: simple checkbox                                            */
/* ------------------------------------------------------------------ */

function Checkbox({
  label,
  checked,
  onChange,
  helpText,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  helpText?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-border bg-bg-input text-orange accent-orange cursor-pointer"
        />
        <span className="text-sm text-text-secondary">{label}</span>
      </label>
      {helpText && <p className="text-text-muted text-xs pl-6">{helpText}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Default state builders                                             */
/* ------------------------------------------------------------------ */

function defaultCircuitBreaker(): CircuitBreakerConfig {
  return {
    failure_threshold: 5,
    success_threshold: 3,
    timeout_seconds: 30,
    failure_status_codes: [500, 502, 503, 504],
    half_open_max_requests: 1,
    trip_on_connection_errors: true,
  };
}

function defaultRetryConfig(): RetryConfig {
  return {
    max_retries: 3,
    retryable_status_codes: [502, 503, 504],
    retryable_methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
    backoff: { fixed: { delay_ms: 100 } },
    retry_on_connect_failure: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Backoff helpers                                                    */
/* ------------------------------------------------------------------ */

type BackoffType = "fixed" | "exponential";

function getBackoffType(b: BackoffStrategy): BackoffType {
  return "fixed" in b ? "fixed" : "exponential";
}

function getFixedDelay(b: BackoffStrategy): number {
  return "fixed" in b ? b.fixed.delay_ms : 1000;
}

function getExponentialBase(b: BackoffStrategy): number {
  return "exponential" in b ? b.exponential.base_ms : 100;
}

function getExponentialMax(b: BackoffStrategy): number {
  return "exponential" in b ? b.exponential.max_ms : 10000;
}

/* ================================================================== */
/*  ProxyForm                                                          */
/* ================================================================== */

export function ProxyForm({ initialData, onSubmit, isLoading }: ProxyFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;

  /* ---------- Basic Configuration ---------- */
  const [name, setName] = useState(initialData?.name ?? "");
  const [listenPath, setListenPath] = useState(initialData?.listen_path ?? "/");
  const [hosts, setHosts] = useState<string[]>(initialData?.hosts ?? []);
  const [backendScheme, setBackendScheme] = useState<NonNullable<Proxy["backend_scheme"]>>(
    initialData?.backend_scheme ?? "https",
  );
  const [backendHost, setBackendHost] = useState(initialData?.backend_host ?? "");
  const [backendPort, setBackendPort] = useState(initialData?.backend_port ?? 80);
  const [backendPath, setBackendPath] = useState(initialData?.backend_path ?? "");

  /* ---------- Routing Options ---------- */
  const [stripListenPath, setStripListenPath] = useState(initialData?.strip_listen_path ?? true);
  const [preserveHostHeader, setPreserveHostHeader] = useState(initialData?.preserve_host_header ?? false);
  const [authMode, setAuthMode] = useState<"single" | "multi">(initialData?.auth_mode ?? "single");
  const [responseBodyMode, setResponseBodyMode] = useState<"stream" | "buffer">(
    initialData?.response_body_mode ?? "stream",
  );
  const [allowedMethods, setAllowedMethods] = useState<string[]>(initialData?.allowed_methods ?? []);
  const [allowedWsOrigins, setAllowedWsOrigins] = useState<string[]>(initialData?.allowed_ws_origins ?? []);

  /* ---------- Backend Timeouts ---------- */
  const [connectTimeout, setConnectTimeout] = useState(initialData?.backend_connect_timeout_ms ?? 5000);
  const [readTimeout, setReadTimeout] = useState(initialData?.backend_read_timeout_ms ?? 30000);
  const [writeTimeout, setWriteTimeout] = useState(initialData?.backend_write_timeout_ms ?? 30000);

  /* ---------- TLS Settings ---------- */
  const [frontendTls, setFrontendTls] = useState(initialData?.frontend_tls ?? false);
  const [passthrough, setPassthrough] = useState(initialData?.passthrough ?? false);
  const [backendTlsVerify, setBackendTlsVerify] = useState(initialData?.backend_tls_verify_server_cert ?? true);
  const [backendTlsCertPath, setBackendTlsCertPath] = useState(initialData?.backend_tls_client_cert_path ?? "");
  const [backendTlsKeyPath, setBackendTlsKeyPath] = useState(initialData?.backend_tls_client_key_path ?? "");
  const [backendTlsCaPath, setBackendTlsCaPath] = useState(initialData?.backend_tls_server_ca_cert_path ?? "");

  /* ---------- Upstream ---------- */
  const [upstreamId, setUpstreamId] = useState(initialData?.upstream_id ?? "");
  const [upstreamSubset, setUpstreamSubset] = useState(initialData?.upstream_subset ?? "");

  /* ---------- Stream extras ---------- */
  const [streamProxyProtocol, setStreamProxyProtocol] = useState(
    initialData?.stream_proxy_protocol ?? false,
  );
  const [backendProxyProtocol, setBackendProxyProtocol] = useState(
    initialData?.backend_proxy_protocol === "v2",
  );
  const [wsIdleTimeout, setWsIdleTimeout] = useState<number | "">(
    initialData?.websocket_idle_timeout_seconds ?? "",
  );
  const [udpAmplificationFactor, setUdpAmplificationFactor] = useState<number | "">(
    initialData?.udp_max_response_amplification_factor ?? "",
  );

  /* ---------- DNS ---------- */
  const [dnsOverride, setDnsOverride] = useState(initialData?.dns_override ?? "");
  const [dnsCacheTtl, setDnsCacheTtl] = useState<number | "">(initialData?.dns_cache_ttl_seconds ?? "");

  /* ---------- Circuit Breaker ---------- */
  const [cbEnabled, setCbEnabled] = useState(!!initialData?.circuit_breaker);
  const [cb, setCb] = useState<CircuitBreakerConfig>(
    initialData?.circuit_breaker ?? defaultCircuitBreaker(),
  );

  /* ---------- Retry ---------- */
  const [retryEnabled, setRetryEnabled] = useState(!!initialData?.retry);
  const [retry, setRetry] = useState<RetryConfig>(initialData?.retry ?? defaultRetryConfig());
  const [backoffType, setBackoffType] = useState<BackoffType>(
    initialData?.retry ? getBackoffType(initialData.retry.backoff) : "fixed",
  );
  const [fixedDelay, setFixedDelay] = useState(
    initialData?.retry ? getFixedDelay(initialData.retry.backoff) : 100,
  );
  const [expBase, setExpBase] = useState(
    initialData?.retry ? getExponentialBase(initialData.retry.backoff) : 100,
  );
  const [expMax, setExpMax] = useState(
    initialData?.retry ? getExponentialMax(initialData.retry.backoff) : 10000,
  );

  /* ---------- Connection Pool ---------- */
  const [poolIdleTimeout, setPoolIdleTimeout] = useState<number | "">(initialData?.pool_idle_timeout_seconds ?? "");
  const [poolKeepAlive, setPoolKeepAlive] = useState(initialData?.pool_enable_http_keep_alive ?? true);
  const [poolHttp2, setPoolHttp2] = useState(initialData?.pool_enable_http2 ?? false);
  const [poolTcpKeepAlive, setPoolTcpKeepAlive] = useState<number | "">(initialData?.pool_tcp_keepalive_seconds ?? "");
  const [poolH2KeepAliveInterval, setPoolH2KeepAliveInterval] = useState<number | "">(
    initialData?.pool_http2_keep_alive_interval_seconds ?? "",
  );
  const [poolH2KeepAliveTimeout, setPoolH2KeepAliveTimeout] = useState<number | "">(
    initialData?.pool_http2_keep_alive_timeout_seconds ?? "",
  );
  const [poolH2InitStreamWindow, setPoolH2InitStreamWindow] = useState<number | "">(
    initialData?.pool_http2_initial_stream_window_size ?? "",
  );
  const [poolH2InitConnWindow, setPoolH2InitConnWindow] = useState<number | "">(
    initialData?.pool_http2_initial_connection_window_size ?? "",
  );
  const [poolH2AdaptiveWindow, setPoolH2AdaptiveWindow] = useState(initialData?.pool_http2_adaptive_window ?? false);
  const [poolH2MaxFrameSize, setPoolH2MaxFrameSize] = useState<number | "">(initialData?.pool_http2_max_frame_size ?? "");
  const [poolH2MaxConcurrentStreams, setPoolH2MaxConcurrentStreams] = useState<number | "">(
    initialData?.pool_http2_max_concurrent_streams ?? "",
  );

  /* ---------- Protocol-Specific ---------- */
  const [listenPort, setListenPort] = useState<number | "">(initialData?.listen_port ?? "");
  const [tcpIdleTimeout, setTcpIdleTimeout] = useState<number | "">(initialData?.tcp_idle_timeout_seconds ?? "");
  const [udpIdleTimeout, setUdpIdleTimeout] = useState(initialData?.udp_idle_timeout_seconds ?? 60);
  const [poolH3ConnsPerBackend, setPoolH3ConnsPerBackend] = useState<number | "">(
    initialData?.pool_http3_connections_per_backend ?? "",
  );

  /* ---------- Scheme family checks ---------- */

  const isTcpLike = backendScheme === "tcp" || backendScheme === "tcps";
  const isUdpLike = backendScheme === "udp" || backendScheme === "dtls";
  const isStream = isTcpLike || isUdpLike;
  const isHttpLike = !isStream;

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (isHttpLike && !listenPath.trim() && hosts.length === 0) {
      errs.listen_path = "Set a listen path or at least one host";
    }
    if (isStream && (listenPort === "" || Number(listenPort) <= 0)) {
      errs.listen_port = "Stream proxies must bind a listen port";
    }
    const usingUpstream = upstreamId.trim().length > 0;
    if (!usingUpstream && !backendHost.trim()) {
      errs.backend_host = "Backend host is required (or link an upstream)";
    }
    if (!usingUpstream && (!backendPort || backendPort <= 0)) {
      errs.backend_port = "Backend port is required";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const buildBackoff = (): BackoffStrategy => {
      if (backoffType === "fixed") return { fixed: { delay_ms: fixedDelay } };
      return { exponential: { base_ms: expBase, max_ms: expMax } };
    };

    const data: ProxyCreate = {
      // Stream proxies must omit listen_path entirely; HTTP proxies may be
      // host-only (null listen_path).
      ...(isHttpLike && listenPath.trim() && { listen_path: listenPath }),
      backend_scheme: backendScheme,
      backend_host: backendHost,
      backend_port: backendPort,
      ...(name && { name }),
      ...(hosts.length > 0 && { hosts }),
      ...(backendPath && { backend_path: backendPath }),
      strip_listen_path: stripListenPath,
      preserve_host_header: preserveHostHeader,
      auth_mode: authMode,
      response_body_mode: responseBodyMode,
      ...(allowedMethods.length > 0 && { allowed_methods: allowedMethods as ProxyCreate["allowed_methods"] }),
      ...(allowedWsOrigins.length > 0 && { allowed_ws_origins: allowedWsOrigins }),
      backend_connect_timeout_ms: connectTimeout,
      backend_read_timeout_ms: readTimeout,
      backend_write_timeout_ms: writeTimeout,
      frontend_tls: frontendTls,
      passthrough,
      backend_tls_verify_server_cert: backendTlsVerify,
      ...(backendTlsCertPath && { backend_tls_client_cert_path: backendTlsCertPath }),
      ...(backendTlsKeyPath && { backend_tls_client_key_path: backendTlsKeyPath }),
      ...(backendTlsCaPath && { backend_tls_server_ca_cert_path: backendTlsCaPath }),
      ...(upstreamId && { upstream_id: upstreamId }),
      ...(upstreamId && upstreamSubset && { upstream_subset: upstreamSubset }),
      ...(dnsOverride && { dns_override: dnsOverride }),
      ...(dnsCacheTtl !== "" && { dns_cache_ttl_seconds: Number(dnsCacheTtl) }),
      ...(cbEnabled && { circuit_breaker: cb }),
      ...(retryEnabled && {
        retry: {
          ...retry,
          backoff: buildBackoff(),
        },
      }),
      ...(poolIdleTimeout !== "" && { pool_idle_timeout_seconds: Number(poolIdleTimeout) }),
      pool_enable_http_keep_alive: poolKeepAlive,
      pool_enable_http2: poolHttp2,
      ...(poolTcpKeepAlive !== "" && { pool_tcp_keepalive_seconds: Number(poolTcpKeepAlive) }),
      ...(poolH2KeepAliveInterval !== "" && { pool_http2_keep_alive_interval_seconds: Number(poolH2KeepAliveInterval) }),
      ...(poolH2KeepAliveTimeout !== "" && { pool_http2_keep_alive_timeout_seconds: Number(poolH2KeepAliveTimeout) }),
      ...(poolH2InitStreamWindow !== "" && { pool_http2_initial_stream_window_size: Number(poolH2InitStreamWindow) }),
      ...(poolH2InitConnWindow !== "" && { pool_http2_initial_connection_window_size: Number(poolH2InitConnWindow) }),
      pool_http2_adaptive_window: poolH2AdaptiveWindow,
      ...(poolH2MaxFrameSize !== "" && { pool_http2_max_frame_size: Number(poolH2MaxFrameSize) }),
      ...(poolH2MaxConcurrentStreams !== "" && { pool_http2_max_concurrent_streams: Number(poolH2MaxConcurrentStreams) }),
      ...(listenPort !== "" && { listen_port: Number(listenPort) }),
      ...(tcpIdleTimeout !== "" && { tcp_idle_timeout_seconds: Number(tcpIdleTimeout) }),
      udp_idle_timeout_seconds: udpIdleTimeout,
      ...(poolH3ConnsPerBackend !== "" && { pool_http3_connections_per_backend: Number(poolH3ConnsPerBackend) }),
      ...(isStream && streamProxyProtocol && { stream_proxy_protocol: true }),
      ...(isTcpLike && backendProxyProtocol && { backend_proxy_protocol: "v2" as const }),
      ...(isHttpLike && wsIdleTimeout !== "" && {
        websocket_idle_timeout_seconds: Number(wsIdleTimeout),
      }),
      ...(isUdpLike && udpAmplificationFactor !== "" && {
        udp_max_response_amplification_factor: Number(udpAmplificationFactor),
      }),
    };

    await onSubmit(data);
  };

  /* ---------- Helpers for optional number inputs ---------- */

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));
  const setNum = (setter: (v: number | "") => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setter(raw === "" ? "" : Number(raw));
  };

  /* ---------- Section visibility ---------- */

  const showListenPath = isHttpLike;
  // Hosts double as SNI route predicates for opaque stream listeners.
  const showHosts = true;
  const showBackendPath = isHttpLike;
  const showRoutingOptions = isHttpLike;
  const showConnectionPool = isHttpLike;
  const supportsHttp2 = backendScheme === "https";
  const showCircuitBreaker = isHttpLike;
  const showRetry = isHttpLike;
  const showProtocolSection = true;

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      {/* ── Section 1: Basic Configuration ── */}
      <div className="border-b border-border/50 py-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Basic Configuration</h3>
        <div className="space-y-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My API Proxy"
          />
          <Select
            label="Backend Scheme"
            value={backendScheme}
            onValueChange={(v) => setBackendScheme(v as NonNullable<Proxy["backend_scheme"]>)}
            options={BACKEND_SCHEMES.map((s) => ({ value: s.value, label: s.label }))}
            helpText="gRPC and WebSocket are auto-detected per request — no separate scheme needed."
          />
          {showListenPath && (
            <Input
              label="Listen Path"
              value={listenPath}
              onChange={(e) => setListenPath(e.target.value)}
              placeholder="/api/v1"
              helpText="Starts with / for prefix, =/ for exact, or ~ for regex. Optional when hosts are set."
              error={errors.listen_path}
            />
          )}
          {showHosts && (
            <TagInput
              label="Hosts"
              values={hosts}
              onChange={(v) => setHosts(v as string[])}
              placeholder="example.com, *.example.com"
              helpText={
                isStream
                  ? "SNI route predicates — only valid on opaque (passthrough / non-TLS TCP) listeners."
                  : "Hostnames this proxy matches. Empty matches all hosts."
              }
            />
          )}
          <Input
            label="Backend Host"
            value={backendHost}
            onChange={(e) => setBackendHost(e.target.value)}
            placeholder="upstream.example.com"
            error={errors.backend_host}
            required
          />
          <Input
            label="Backend Port"
            type="number"
            value={String(backendPort)}
            onChange={(e) => setBackendPort(Number(e.target.value))}
            placeholder="80"
            error={errors.backend_port}
            required
          />
          {showBackendPath && (
            <Input
              label="Backend Path"
              value={backendPath}
              onChange={(e) => setBackendPath(e.target.value)}
              placeholder="/v2"
            />
          )}
        </div>
      </div>

      {/* ── Section 2: Routing Options ── */}
      {showRoutingOptions && (
        <CollapsibleSection title="Routing Options">
          <Checkbox label="Strip listen path" checked={stripListenPath} onChange={setStripListenPath} />
          <Checkbox label="Preserve host header" checked={preserveHostHeader} onChange={setPreserveHostHeader} />
          <Select
            label="Auth Mode"
            value={authMode}
            onValueChange={(v) => setAuthMode(v as "single" | "multi")}
            options={[
              { value: "single", label: "Single (first success wins)" },
              { value: "multi", label: "Multi (try all until success)" },
            ]}
          />
          <Select
            label="Response Body Mode"
            value={responseBodyMode}
            onValueChange={(v) => setResponseBodyMode(v as "stream" | "buffer")}
            options={[
              { value: "stream", label: "Stream" },
              { value: "buffer", label: "Buffer" },
            ]}
          />
          <MethodCheckboxGroup
            label="Allowed Methods"
            selected={allowedMethods}
            onChange={setAllowedMethods}
            options={ALL_HTTP_METHODS}
          />
          <TagInput
            label="Allowed WebSocket Origins"
            values={allowedWsOrigins}
            onChange={(v) => setAllowedWsOrigins(v as string[])}
            placeholder="https://example.com"
            helpText="Protects WebSocket upgrades against CSWSH. Leave empty to allow all origins."
          />
          <Input
            label="WebSocket Idle Timeout (seconds)"
            type="number"
            value={numVal(wsIdleTimeout)}
            onChange={setNum(setWsIdleTimeout)}
            placeholder="300"
            helpText="Idle timeout for upgraded WebSocket sessions. 0 disables the idle bound."
          />
        </CollapsibleSection>
      )}

      {/* ── Section 3: Backend Timeouts ── */}
      <CollapsibleSection title="Backend Timeouts">
        <Input
          label="Connect Timeout (ms)"
          type="number"
          value={String(connectTimeout)}
          onChange={(e) => setConnectTimeout(Number(e.target.value))}
        />
        <Input
          label="Read Timeout (ms)"
          type="number"
          value={String(readTimeout)}
          onChange={(e) => setReadTimeout(Number(e.target.value))}
        />
        <Input
          label="Write Timeout (ms)"
          type="number"
          value={String(writeTimeout)}
          onChange={(e) => setWriteTimeout(Number(e.target.value))}
        />
      </CollapsibleSection>

      {/* ── Section 4: TLS Settings ── */}
      <CollapsibleSection title="TLS Settings">
        <Checkbox
          label="Frontend TLS"
          checked={frontendTls}
          onChange={(v) => {
            setFrontendTls(v);
            if (v) setPassthrough(false);
          }}
          helpText="Terminate TLS on the gateway for incoming connections"
        />
        {isStream && (
          <Checkbox
            label="Passthrough"
            checked={passthrough}
            onChange={(v) => {
              setPassthrough(v);
              if (v) setFrontendTls(false);
            }}
            helpText="Forward encrypted bytes directly to backend without terminating TLS/DTLS. Mutually exclusive with Frontend TLS."
          />
        )}
        <Checkbox
          label="Verify backend TLS server certificate"
          checked={backendTlsVerify}
          onChange={setBackendTlsVerify}
        />
        <Input
          label="Backend TLS Client Cert Path"
          value={backendTlsCertPath}
          onChange={(e) => setBackendTlsCertPath(e.target.value)}
          placeholder="/path/to/cert.pem"
        />
        <Input
          label="Backend TLS Client Key Path"
          value={backendTlsKeyPath}
          onChange={(e) => setBackendTlsKeyPath(e.target.value)}
          placeholder="/path/to/key.pem"
        />
        <Input
          label="Backend TLS Server CA Cert Path"
          value={backendTlsCaPath}
          onChange={(e) => setBackendTlsCaPath(e.target.value)}
          placeholder="/path/to/ca.pem"
        />
      </CollapsibleSection>

      {/* ── Section 5: Upstream ── */}
      <CollapsibleSection title="Upstream" badge={upstreamId ? "LINKED" : undefined}>
        <Input
          label="Upstream ID"
          value={upstreamId}
          onChange={(e) => setUpstreamId(e.target.value)}
          placeholder="upstream-uuid"
          helpText="Link this proxy to an upstream load-balancer group. Overrides backend host/port."
        />
        {upstreamId && (
          <Input
            label="Upstream Subset"
            value={upstreamSubset}
            onChange={(e) => setUpstreamSubset(e.target.value)}
            placeholder="v2"
            helpText="Optional named subset defined on the upstream (DestinationRule-style routing)."
          />
        )}
      </CollapsibleSection>

      {/* ── Section 6: DNS ── */}
      <CollapsibleSection title="DNS">
        <Input
          label="DNS Override"
          value={dnsOverride}
          onChange={(e) => setDnsOverride(e.target.value)}
          placeholder="10.0.0.1"
        />
        <Input
          label="DNS Cache TTL (seconds)"
          type="number"
          value={numVal(dnsCacheTtl)}
          onChange={setNum(setDnsCacheTtl)}
        />
      </CollapsibleSection>

      {/* ── Section 7: Circuit Breaker ── */}
      {showCircuitBreaker && (
      <CollapsibleSection title="Circuit Breaker" badge={cbEnabled ? "ON" : undefined}>
        <Checkbox
          label="Enable circuit breaker"
          checked={cbEnabled}
          onChange={setCbEnabled}
        />
        {cbEnabled && (
          <div className="space-y-4 pl-6 border-l-2 border-border/50">
            <Input
              label="Failure Threshold"
              type="number"
              value={String(cb.failure_threshold)}
              onChange={(e) => setCb({ ...cb, failure_threshold: Number(e.target.value) })}
            />
            <Input
              label="Success Threshold"
              type="number"
              value={String(cb.success_threshold)}
              onChange={(e) => setCb({ ...cb, success_threshold: Number(e.target.value) })}
            />
            <Input
              label="Timeout (seconds)"
              type="number"
              value={String(cb.timeout_seconds)}
              onChange={(e) => setCb({ ...cb, timeout_seconds: Number(e.target.value) })}
            />
            <TagInput
              label="Failure Status Codes"
              values={cb.failure_status_codes}
              onChange={(v) => setCb({ ...cb, failure_status_codes: v as number[] })}
              placeholder="500, 502, 503"
              parseAsNumber
            />
            <Input
              label="Half-Open Max Requests"
              type="number"
              value={String(cb.half_open_max_requests)}
              onChange={(e) => setCb({ ...cb, half_open_max_requests: Number(e.target.value) })}
            />
            <Checkbox
              label="Trip on connection errors"
              checked={cb.trip_on_connection_errors}
              onChange={(v) => setCb({ ...cb, trip_on_connection_errors: v })}
            />
          </div>
        )}
      </CollapsibleSection>
      )}

      {/* ── Section 8: Retry ── */}
      {showRetry && (
      <CollapsibleSection title="Retry" badge={retryEnabled ? "ON" : undefined}>
        <Checkbox
          label="Enable retry"
          checked={retryEnabled}
          onChange={setRetryEnabled}
        />
        {retryEnabled && (
          <div className="space-y-4 pl-6 border-l-2 border-border/50">
            <Input
              label="Max Retries"
              type="number"
              value={String(retry.max_retries)}
              onChange={(e) => setRetry({ ...retry, max_retries: Number(e.target.value) })}
            />
            <TagInput
              label="Retryable Status Codes"
              values={retry.retryable_status_codes}
              onChange={(v) => setRetry({ ...retry, retryable_status_codes: v as number[] })}
              placeholder="502, 503, 504"
              parseAsNumber
            />
            <MethodCheckboxGroup
              label="Retryable Methods"
              selected={retry.retryable_methods}
              onChange={(v) => setRetry({ ...retry, retryable_methods: v })}
              options={ALL_HTTP_METHODS}
            />
            <Select
              label="Backoff Strategy"
              value={backoffType}
              onValueChange={(v) => setBackoffType(v as BackoffType)}
              options={[
                { value: "fixed", label: "Fixed" },
                { value: "exponential", label: "Exponential" },
              ]}
            />
            {backoffType === "fixed" ? (
              <Input
                label="Delay (ms)"
                type="number"
                value={String(fixedDelay)}
                onChange={(e) => setFixedDelay(Number(e.target.value))}
              />
            ) : (
              <>
                <Input
                  label="Base (ms)"
                  type="number"
                  value={String(expBase)}
                  onChange={(e) => setExpBase(Number(e.target.value))}
                />
                <Input
                  label="Max (ms)"
                  type="number"
                  value={String(expMax)}
                  onChange={(e) => setExpMax(Number(e.target.value))}
                />
              </>
            )}
            <Checkbox
              label="Retry on connect failure"
              checked={retry.retry_on_connect_failure}
              onChange={(v) => setRetry({ ...retry, retry_on_connect_failure: v })}
            />
          </div>
        )}
      </CollapsibleSection>
      )}

      {/* ── Section 9: Connection Pool ── */}
      {showConnectionPool && (
        <CollapsibleSection title="Connection Pool">
          <Input
            label="Pool Idle Timeout (seconds)"
            type="number"
            value={numVal(poolIdleTimeout)}
            onChange={setNum(setPoolIdleTimeout)}
          />
          <Checkbox label="Enable HTTP Keep-Alive" checked={poolKeepAlive} onChange={setPoolKeepAlive} />
          <Checkbox label="Enable HTTP/2" checked={poolHttp2} onChange={setPoolHttp2} />
          <Input
            label="TCP Keep-Alive (seconds)"
            type="number"
            value={numVal(poolTcpKeepAlive)}
            onChange={setNum(setPoolTcpKeepAlive)}
          />
          {supportsHttp2 && (
            <>
              <Input
                label="HTTP/2 Keep-Alive Interval (seconds)"
                type="number"
                value={numVal(poolH2KeepAliveInterval)}
                onChange={setNum(setPoolH2KeepAliveInterval)}
              />
              <Input
                label="HTTP/2 Keep-Alive Timeout (seconds)"
                type="number"
                value={numVal(poolH2KeepAliveTimeout)}
                onChange={setNum(setPoolH2KeepAliveTimeout)}
              />
              <Input
                label="HTTP/2 Initial Stream Window Size"
                type="number"
                value={numVal(poolH2InitStreamWindow)}
                onChange={setNum(setPoolH2InitStreamWindow)}
              />
              <Input
                label="HTTP/2 Initial Connection Window Size"
                type="number"
                value={numVal(poolH2InitConnWindow)}
                onChange={setNum(setPoolH2InitConnWindow)}
              />
              <Checkbox label="HTTP/2 Adaptive Window" checked={poolH2AdaptiveWindow} onChange={setPoolH2AdaptiveWindow} />
              <Input
                label="HTTP/2 Max Frame Size"
                type="number"
                value={numVal(poolH2MaxFrameSize)}
                onChange={setNum(setPoolH2MaxFrameSize)}
              />
              <Input
                label="HTTP/2 Max Concurrent Streams"
                type="number"
                value={numVal(poolH2MaxConcurrentStreams)}
                onChange={setNum(setPoolH2MaxConcurrentStreams)}
              />
            </>
          )}
        </CollapsibleSection>
      )}

      {/* ── Section 10: Protocol-Specific ── */}
      {showProtocolSection && (
        <CollapsibleSection
          title="Protocol-Specific"
          badge={backendScheme.toUpperCase()}
        >
          <Input
            label="Listen Port"
            type="number"
            value={numVal(listenPort)}
            onChange={setNum(setListenPort)}
            helpText={
              isStream
                ? "Required — stream proxies bind and route by this port."
                : "Optional — scopes this HTTP proxy to one frontend port."
            }
            error={errors.listen_port}
          />
          {isTcpLike && (
            <Input
              label="TCP Idle Timeout (seconds)"
              type="number"
              value={numVal(tcpIdleTimeout)}
              onChange={setNum(setTcpIdleTimeout)}
            />
          )}
          {isUdpLike && (
            <>
              <Input
                label="UDP Idle Timeout (seconds)"
                type="number"
                value={String(udpIdleTimeout)}
                onChange={(e) => setUdpIdleTimeout(Number(e.target.value))}
              />
              <Input
                label="Max Response Amplification Factor"
                type="number"
                value={numVal(udpAmplificationFactor)}
                onChange={setNum(setUdpAmplificationFactor)}
                placeholder="8"
                helpText="Caps backend→client bytes per request payload byte. Protects against UDP reflection attacks."
              />
            </>
          )}
          {isStream && (
            <Checkbox
              label="Inbound PROXY protocol"
              checked={streamProxyProtocol}
              onChange={setStreamProxyProtocol}
              helpText="Read PROXY protocol v1/v2 headers from a trusted load balancer to recover client IPs."
            />
          )}
          {isTcpLike && (
            <Checkbox
              label="Outbound PROXY protocol v2 to backend"
              checked={backendProxyProtocol}
              onChange={setBackendProxyProtocol}
              helpText="Prepend a PROXY v2 header on backend connects so backends see the client IP."
            />
          )}
          {backendScheme === "https" && (
            <Input
              label="HTTP/3 Connections Per Backend"
              type="number"
              value={numVal(poolH3ConnsPerBackend)}
              onChange={setNum(setPoolH3ConnsPerBackend)}
              helpText="QUIC connections per H3-capable backend (H3 is auto-selected when supported)."
            />
          )}
        </CollapsibleSection>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center justify-end gap-3 pt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate({ to: "/proxies" })}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" loading={isLoading}>
          {isEdit ? "Update Proxy" : "Create Proxy"}
        </Button>
      </div>
    </form>
  );
}
