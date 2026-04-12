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

const BACKEND_PROTOCOLS: Proxy["backend_protocol"][] = [
  "http",
  "https",
  "ws",
  "wss",
  "grpc",
  "grpcs",
  "h3",
  "tcp",
  "tcp_tls",
  "udp",
  "dtls",
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
  const [backendProtocol, setBackendProtocol] = useState<Proxy["backend_protocol"]>(
    initialData?.backend_protocol ?? "http",
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

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!listenPath.trim()) errs.listen_path = "Listen path is required";
    if (!backendHost.trim()) errs.backend_host = "Backend host is required";
    if (!backendPort || backendPort <= 0) errs.backend_port = "Backend port is required";
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
      listen_path: listenPath,
      backend_protocol: backendProtocol,
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
    };

    await onSubmit(data);
  };

  /* ---------- Helpers for optional number inputs ---------- */

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));
  const setNum = (setter: (v: number | "") => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setter(raw === "" ? "" : Number(raw));
  };

  /* ---------- Protocol checks ---------- */

  const isTcpLike = backendProtocol === "tcp" || backendProtocol === "tcp_tls";
  const isUdpLike = backendProtocol === "udp" || backendProtocol === "dtls";
  const isH3 = backendProtocol === "h3";
  const isWebSocket = backendProtocol === "ws" || backendProtocol === "wss";
  const showProtocolSection = isTcpLike || isUdpLike || isH3;

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
          <Input
            label="Listen Path"
            value={listenPath}
            onChange={(e) => setListenPath(e.target.value)}
            placeholder="/api/v1"
            helpText='Starts with / for literal or ~ for regex'
            error={errors.listen_path}
            required
          />
          <TagInput
            label="Hosts"
            values={hosts}
            onChange={(v) => setHosts(v as string[])}
            placeholder="example.com, api.example.com"
            helpText="Comma-separated hostnames, press Enter to add"
          />
          <Select
            label="Backend Protocol"
            value={backendProtocol}
            onValueChange={(v) => setBackendProtocol(v as Proxy["backend_protocol"])}
            options={BACKEND_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))}
          />
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
          <Input
            label="Backend Path"
            value={backendPath}
            onChange={(e) => setBackendPath(e.target.value)}
            placeholder="/v2"
          />
        </div>
      </div>

      {/* ── Section 2: Routing Options ── */}
      <CollapsibleSection title="Routing Options">
        <Checkbox label="Strip listen path" checked={stripListenPath} onChange={setStripListenPath} />
        <Checkbox label="Preserve host header" checked={preserveHostHeader} onChange={setPreserveHostHeader} />
        <Select
          label="Auth Mode"
          value={authMode}
          onValueChange={(v) => setAuthMode(v as "single" | "multi")}
          options={[
            { value: "single", label: "Single" },
            { value: "multi", label: "Multi" },
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
        {isWebSocket && (
          <TagInput
            label="Allowed WebSocket Origins"
            values={allowedWsOrigins}
            onChange={(v) => setAllowedWsOrigins(v as string[])}
            placeholder="https://example.com"
            helpText="Protects against Cross-Site WebSocket Hijacking (CSWSH). Leave empty to allow all origins."
          />
        )}
      </CollapsibleSection>

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
          helpText="Mutually exclusive with Passthrough"
        />
        <Checkbox
          label="Passthrough"
          checked={passthrough}
          onChange={(v) => {
            setPassthrough(v);
            if (v) setFrontendTls(false);
          }}
          helpText="Mutually exclusive with Frontend TLS. Only valid for stream proxies (tcp, tcp_tls, udp, dtls)"
        />
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
      <CollapsibleSection title="Upstream">
        <Input
          label="Upstream ID"
          value={upstreamId}
          onChange={(e) => setUpstreamId(e.target.value)}
          placeholder="upstream-uuid"
          helpText="Link this proxy to an upstream load-balancer group"
        />
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

      {/* ── Section 8: Retry ── */}
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

      {/* ── Section 9: Connection Pool ── */}
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
      </CollapsibleSection>

      {/* ── Section 10: Protocol-Specific ── */}
      {showProtocolSection && (
        <CollapsibleSection
          title="Protocol-Specific"
          badge={backendProtocol.toUpperCase()}
        >
          {(isTcpLike || isUdpLike) && (
            <Input
              label="Listen Port"
              type="number"
              value={numVal(listenPort)}
              onChange={setNum(setListenPort)}
              helpText="Required for TCP/UDP protocols"
            />
          )}
          {isTcpLike && (
            <Input
              label="TCP Idle Timeout (seconds)"
              type="number"
              value={numVal(tcpIdleTimeout)}
              onChange={setNum(setTcpIdleTimeout)}
            />
          )}
          {isUdpLike && (
            <Input
              label="UDP Idle Timeout (seconds)"
              type="number"
              value={String(udpIdleTimeout)}
              onChange={(e) => setUdpIdleTimeout(Number(e.target.value))}
            />
          )}
          {isH3 && (
            <Input
              label="HTTP/3 Connections Per Backend"
              type="number"
              value={numVal(poolH3ConnsPerBackend)}
              onChange={setNum(setPoolH3ConnsPerBackend)}
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
