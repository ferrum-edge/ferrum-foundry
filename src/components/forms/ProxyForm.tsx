/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy create / edit form                         */
/* ------------------------------------------------------------------ */

import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { CollapsibleSection } from "./CollapsibleSection";
import { TagInput } from "./TagInput";
import { FormValidationSummary } from "./FormValidationSummary";
import { useCollapsibleFormValidation } from "@/lib/collapsedFormValidation";
import { BACKEND_TLS_OPERATOR_SCOPE_NOTE } from "@/lib/backendTlsReferences";
import {
  isValidPort,
  missingNumberError,
  numberDraftFromInput,
  numberDraftText,
  PORT_RANGE_ERROR,
  resolveNumberDrafts,
  type NumberDraft,
  type WithNumberDrafts,
} from "@/lib/formDrafts";
import { ReadOnlySurface } from "@/components/shared/CapabilityGate";
import type { CapabilityVerdict } from "@/lib/capabilities";
import type {
  BackendScheme,
  Proxy,
  ProxyCreate,
  CircuitBreakerConfig,
  CircuitBreakerConfigInput,
  RetryConfig,
  RetryConfigInput,
  BackoffStrategy,
} from "@/api/types";

const PROXY_COLLAPSIBLE_SECTIONS = [
  { id: "routing", errorKeys: ["allowed_methods"] },
  {
    id: "timeouts",
    errorKeys: ["connect_timeout", "read_timeout", "write_timeout"],
  },
  { id: "tls", errorKeys: [] },
  { id: "upstream", errorKeys: [] },
  { id: "dns", errorKeys: [] },
  {
    id: "circuit-breaker",
    errorKeys: [
      "cb_failure_threshold",
      "cb_success_threshold",
      "cb_timeout_seconds",
      "cb_half_open_max_requests",
    ],
  },
  {
    id: "retry",
    errorKeys: ["retry_max_retries", "retry_fixed_delay", "retry_exp_base", "retry_exp_max"],
  },
  { id: "connection-pool", errorKeys: [] },
  { id: "protocol", errorKeys: ["listen_port", "udp_idle_timeout"] },
] as const;

// Required numeric fields hold `""` while cleared so the input never snaps
// to `0`; validate() rejects an empty value before anything is sent.
const CB_NUMBER_FIELDS = [
  ["failure_threshold", "Failure threshold"],
  ["success_threshold", "Success threshold"],
  ["timeout_seconds", "Timeout"],
  ["half_open_max_requests", "Half-open max requests"],
] as const;
const CB_NUMBER_KEYS = CB_NUMBER_FIELDS.map(([key]) => key);
type CircuitBreakerDraft = WithNumberDrafts<
  CircuitBreakerConfig,
  (typeof CB_NUMBER_KEYS)[number]
>;
type RetryConfigDraft = WithNumberDrafts<RetryConfig, "max_retries">;


export interface ProxyFormProps {
  initialData?: Proxy;
  onSubmit: (data: ProxyCreate) => Promise<void>;
  isLoading: boolean;
  /**
   * Write capability for this surface. When it is denied the form renders
   * read-only with the reason above it and refuses to submit; the gateway
   * still enforces the same rule for anything the UI has not observed.
   */
  capability?: CapabilityVerdict;
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
/*  Per-scheme field set                                               */
/* ------------------------------------------------------------------ */

/** gRPC and WebSocket ride the HTTP family; tcps and dtls add TLS/DTLS. */
type SchemeFamily = "http" | "tcp" | "udp";

const SCHEME_FAMILY: Record<BackendScheme, SchemeFamily> = {
  http: "http",
  https: "http",
  tcp: "tcp",
  tcps: "tcp",
  udp: "udp",
  dtls: "udp",
};

/**
 * The proxy fields Ferrum Edge reads for one backend scheme. Display,
 * validation and serialization all follow this one set: a field outside it is
 * hidden, never validated and never sent, so a value left over from another
 * scheme can neither block a save nor reach the gateway (#655). That holds for
 * nested fields too, because Edge validates every member of an object it is
 * sent.
 *
 * Taken from Edge's `Proxy::validate_fields` and its stream relays
 * (`tcp_proxy.rs`, `udp_proxy.rs`):
 * - TCP and UDP both consult `circuit_breaker` on every backend dial; only
 *   HTTP reads its `failure_status_codes`, so a stream proxy's breaker omits
 *   them and Edge applies its default.
 * - TCP re-dials under `retry` (`max_retries`, backoff,
 *   `retry_on_connect_failure`); UDP never retries. Retryable status codes and
 *   methods are HTTP-only, so a TCP proxy's retry omits them and Edge applies
 *   its defaults.
 * - TCP uses the backend read/write timeouts as per-direction inactivity
 *   bounds; UDP reads only the connect timeout.
 * - Connection-pool overrides (HTTP/2 tuning included, which the h2c gRPC
 *   pool of an `http` proxy also reads), `backend_path`, method restriction
 *   and the other routing options exist only on the HTTP path. HTTP/3 needs
 *   TLS, so only `https` reads its pool size.
 * - Edge refuses `upstream_subset` on udp/dtls, `passthrough` and inbound
 *   `stream_proxy_protocol` on HTTP, and outbound PROXY protocol off TCP.
 * - Backend TLS client material, the custom CA and an unverified backend are
 *   refused on plaintext schemes (http, tcp, udp), and the material and CA
 *   under passthrough, where Ferrum originates no backend TLS.
 *
 * `udp_idle_timeout_seconds` is not in the set: Edge stores and range-checks
 * it on every proxy, so the form keeps sending it for every scheme.
 */
interface SchemeFields {
  listenPath: boolean;
  backendPath: boolean;
  /** Strip/preserve, path parameters, auth and body modes, methods, WebSocket. */
  routing: boolean;
  /** `backend_read_timeout_ms` and `backend_write_timeout_ms`. */
  ioTimeouts: boolean;
  circuitBreaker: boolean;
  circuitBreakerStatusCodes: boolean;
  retry: boolean;
  /** `retryable_status_codes` and `retryable_methods`. */
  retryHttpMatchers: boolean;
  connectionPool: boolean;
  http3Pool: boolean;
  upstreamSubset: boolean;
  passthrough: boolean;
  streamProxyProtocol: boolean;
  backendProxyProtocol: boolean;
  tcpIdleTimeout: boolean;
  udpSession: boolean;
  /**
   * Backend TLS client cert/key, server CA and `verify_server_cert: false`.
   * Off, the paths are omitted and verification is sent as Edge's default.
   */
  backendTls: boolean;
}

const TLS_BACKEND_SCHEMES: ReadonlySet<BackendScheme> = new Set(["https", "tcps", "dtls"]);

function proxySchemeFields(scheme: BackendScheme, passthrough: boolean): SchemeFields {
  const family = SCHEME_FAMILY[scheme];
  const http = family === "http";
  const tcp = family === "tcp";
  const udp = family === "udp";
  return {
    listenPath: http,
    backendPath: http,
    routing: http,
    ioTimeouts: !udp,
    circuitBreaker: true,
    circuitBreakerStatusCodes: http,
    retry: !udp,
    retryHttpMatchers: http,
    connectionPool: http,
    http3Pool: scheme === "https",
    upstreamSubset: !udp,
    passthrough: !http,
    streamProxyProtocol: !http,
    backendProxyProtocol: tcp,
    tcpIdleTimeout: tcp,
    udpSession: udp,
    // Passthrough exists only on stream proxies (an HTTP proxy sends false).
    backendTls: TLS_BACKEND_SCHEMES.has(scheme) && (http || !passthrough),
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Checkbox group for methods                                 */
/* ------------------------------------------------------------------ */

function MethodCheckboxGroup({
  label,
  selected,
  onChange,
  options,
  error,
}: {
  label: string;
  selected: string[];
  onChange: (selected: string[]) => void;
  options: readonly string[];
  error?: string;
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
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:disabled]:pointer-events-none ${
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
      {error && <p className="text-danger text-xs">{error}</p>}
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
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="inline-flex items-center gap-2 cursor-pointer select-none has-[:disabled]:cursor-not-allowed"
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-border bg-bg-input text-orange accent-orange cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
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

export function ProxyForm({
  initialData,
  onSubmit,
  isLoading,
  capability,
}: ProxyFormProps) {
  const readOnly = capability !== undefined && !capability.allowed;
  const navigate = useNavigate();
  const isEdit = !!initialData;
  const formRef = useRef<HTMLFormElement>(null);
  const collapsible = useCollapsibleFormValidation(PROXY_COLLAPSIBLE_SECTIONS, readOnly);

  /* ---------- Basic Configuration ---------- */
  // Seeded once per editor identity: the parent keys this form on
  // `{ namespace, resourceId }` so a tenant or resource change remounts it,
  // while a background refetch of the same identity never rewrites fields
  // (see the refresh policy in `src/lib/editorIdentity.ts`).
  const [name, setName] = useState(initialData?.name ?? "");
  const [listenPath, setListenPath] = useState(initialData ? initialData.listen_path ?? "" : "/");
  const [hosts, setHosts] = useState<string[]>(initialData?.hosts ?? []);
  const [backendScheme, setBackendScheme] = useState<NonNullable<Proxy["backend_scheme"]>>(
    initialData?.backend_scheme ?? "https",
  );
  const [backendHost, setBackendHost] = useState(initialData?.backend_host ?? "");
  const [backendPort, setBackendPort] = useState<NumberDraft>(initialData?.backend_port ?? 80);
  const [backendPath, setBackendPath] = useState(initialData?.backend_path ?? "");

  /* ---------- Routing Options ---------- */
  const [stripListenPath, setStripListenPath] = useState(initialData?.strip_listen_path ?? true);
  const [preserveHostHeader, setPreserveHostHeader] = useState(initialData?.preserve_host_header ?? false);
  const [allowPathParameters, setAllowPathParameters] = useState(
    initialData?.allow_path_parameters ?? false,
  );
  const [authMode, setAuthMode] = useState<"single" | "multi">(initialData?.auth_mode ?? "single");
  const [responseBodyMode, setResponseBodyMode] = useState<"stream" | "buffer">(
    initialData?.response_body_mode ?? "stream",
  );
  const [allowedMethods, setAllowedMethods] = useState<string[]>(initialData?.allowed_methods ?? []);
  const [restrictMethods, setRestrictMethods] = useState(
    initialData?.allowed_methods !== null && initialData?.allowed_methods !== undefined,
  );
  const [allowedWsOrigins, setAllowedWsOrigins] = useState<string[]>(initialData?.allowed_ws_origins ?? []);

  /* ---------- Backend Timeouts ---------- */
  const [connectTimeout, setConnectTimeout] = useState<NumberDraft>(
    initialData?.backend_connect_timeout_ms ?? 5000,
  );
  const [readTimeout, setReadTimeout] = useState<NumberDraft>(
    initialData?.backend_read_timeout_ms ?? 30000,
  );
  const [writeTimeout, setWriteTimeout] = useState<NumberDraft>(
    initialData?.backend_write_timeout_ms ?? 30000,
  );

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
  const [cb, setCb] = useState<CircuitBreakerDraft>(
    initialData?.circuit_breaker ?? defaultCircuitBreaker(),
  );

  /* ---------- Retry ---------- */
  const [retryEnabled, setRetryEnabled] = useState(!!initialData?.retry);
  const [retry, setRetry] = useState<RetryConfigDraft>(initialData?.retry ?? defaultRetryConfig());
  const [backoffType, setBackoffType] = useState<BackoffType>(
    initialData?.retry ? getBackoffType(initialData.retry.backoff) : "fixed",
  );
  const [fixedDelay, setFixedDelay] = useState<NumberDraft>(
    initialData?.retry ? getFixedDelay(initialData.retry.backoff) : 100,
  );
  const [expBase, setExpBase] = useState<NumberDraft>(
    initialData?.retry ? getExponentialBase(initialData.retry.backoff) : 100,
  );
  const [expMax, setExpMax] = useState<NumberDraft>(
    initialData?.retry ? getExponentialMax(initialData.retry.backoff) : 10000,
  );

  /* ---------- Connection Pool ---------- */
  const [poolIdleTimeout, setPoolIdleTimeout] = useState<number | "">(initialData?.pool_idle_timeout_seconds ?? "");
  const [poolKeepAlive, setPoolKeepAlive] = useState<boolean | null>(
    initialData?.pool_enable_http_keep_alive ?? null,
  );
  const [poolHttp2, setPoolHttp2] = useState<boolean | null>(
    initialData?.pool_enable_http2 ?? null,
  );
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
  const [poolH2AdaptiveWindow, setPoolH2AdaptiveWindow] = useState<boolean | null>(
    initialData?.pool_http2_adaptive_window ?? null,
  );
  const [poolH2MaxFrameSize, setPoolH2MaxFrameSize] = useState<number | "">(initialData?.pool_http2_max_frame_size ?? "");
  const [poolH2MaxConcurrentStreams, setPoolH2MaxConcurrentStreams] = useState<number | "">(
    initialData?.pool_http2_max_concurrent_streams ?? "",
  );
  const [poolMaxRequests, setPoolMaxRequests] = useState<number | "">(
    initialData?.pool_max_requests_per_connection ?? "",
  );

  /* ---------- Protocol-Specific ---------- */
  const [listenPort, setListenPort] = useState<number | "">(initialData?.listen_port ?? "");
  const [tcpIdleTimeout, setTcpIdleTimeout] = useState<number | "">(initialData?.tcp_idle_timeout_seconds ?? "");
  const [udpIdleTimeout, setUdpIdleTimeout] = useState<NumberDraft>(
    initialData?.udp_idle_timeout_seconds ?? 60,
  );
  const [poolH3ConnsPerBackend, setPoolH3ConnsPerBackend] = useState<number | "">(
    initialData?.pool_http3_connections_per_backend ?? "",
  );

  /* ---------- Scheme field set ---------- */

  const fields = proxySchemeFields(backendScheme, passthrough);
  const isStream = SCHEME_FAMILY[backendScheme] !== "http";

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (fields.listenPath && !listenPath.trim() && hosts.length === 0) {
      errs.listen_path = "Set a listen path or at least one host";
    }
    if (isStream && listenPort === "") {
      errs.listen_port = "Stream proxies must bind a listen port";
    } else if (listenPort !== "" && !isValidPort(listenPort)) {
      errs.listen_port = PORT_RANGE_ERROR;
    }
    const usingUpstream = upstreamId.trim().length > 0;
    if (!usingUpstream && !backendHost.trim()) {
      errs.backend_host = "Backend host is required (or link an upstream)";
    }
    if (!usingUpstream && backendPort === "") {
      errs.backend_port = "Backend port is required";
    } else if (
      // With an upstream linked the backend port is unused and may stay unset
      // (sent as 0); any other value must still be a port Edge can store.
      (!usingUpstream || (backendPort !== "" && backendPort !== 0)) &&
      !isValidPort(backendPort)
    ) {
      errs.backend_port = PORT_RANGE_ERROR;
    }
    const requireNumber = (key: string, value: NumberDraft | undefined, label: string) => {
      const error = missingNumberError(value, label);
      if (error) errs[key] = error;
    };
    requireNumber("connect_timeout", connectTimeout, "Connect timeout");
    if (fields.ioTimeouts) {
      requireNumber("read_timeout", readTimeout, "Read timeout");
      requireNumber("write_timeout", writeTimeout, "Write timeout");
    }
    if (fields.circuitBreaker && cbEnabled) {
      for (const [key, label] of CB_NUMBER_FIELDS) requireNumber(`cb_${key}`, cb[key], label);
    }
    if (fields.retry && retryEnabled) {
      requireNumber("retry_max_retries", retry.max_retries, "Max retries");
      if (backoffType === "fixed") {
        requireNumber("retry_fixed_delay", fixedDelay, "Delay");
      } else {
        requireNumber("retry_exp_base", expBase, "Base delay");
        requireNumber("retry_exp_max", expMax, "Max delay");
      }
    }
    if (fields.udpSession) requireNumber("udp_idle_timeout", udpIdleTimeout, "UDP idle timeout");
    // The gateway requires at least one method (`minItems: 1`); an empty
    // restriction is a 400, not "allow nothing".
    if (fields.routing && restrictMethods && allowedMethods.length === 0) {
      errs.allowed_methods = "Select at least one method, or stop restricting methods";
    }
    setErrors(errs);
    const ok = Object.keys(errs).length === 0;
    if (!ok) {
      collapsible.onValidationFailed(errs, formRef.current);
    } else {
      collapsible.clearValidationSummary();
    }
    return ok;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    if (!validate()) return;

    // validate() has rejected every empty draft that is sent below.
    const buildBackoff = (): BackoffStrategy => {
      if (backoffType === "fixed") return { fixed: { delay_ms: Number(fixedDelay) } };
      return { exponential: { base_ms: Number(expBase), max_ms: Number(expMax) } };
    };
    // Nested HTTP matchers follow the field set too: Edge validates whatever
    // it is sent, and the whole object replaces the stored one on update.
    const buildCircuitBreaker = (): CircuitBreakerConfigInput => {
      const { failure_status_codes, ...breaker } = resolveNumberDrafts(cb, CB_NUMBER_KEYS);
      return fields.circuitBreakerStatusCodes ? { ...breaker, failure_status_codes } : breaker;
    };
    const buildRetry = (): RetryConfigInput => {
      const { retryable_status_codes, retryable_methods, ...rest } = resolveNumberDrafts(
        retry,
        ["max_retries"],
      );
      const policy = { ...rest, backoff: buildBackoff() };
      return fields.retryHttpMatchers
        ? { ...policy, retryable_status_codes, retryable_methods }
        : policy;
    };

    // Every field outside `fields` is omitted, never sent with a stale value.
    // An omitted optional is cleared on update (`mergeFormUpdatePayload`); the
    // fields Edge constrains on stream proxies are sent with the value it
    // requires there instead, because an omitted one keeps the stored value.
    const data: ProxyCreate = {
      // Stream proxies must omit listen_path entirely; HTTP proxies may be
      // host-only (null listen_path).
      ...(fields.listenPath && listenPath.trim() && { listen_path: listenPath }),
      backend_scheme: backendScheme,
      backend_host: backendHost,
      // Only an upstream-linked proxy may leave the port empty; the gateway
      // documents 0 as that omitted port.
      backend_port: backendPort === "" ? 0 : backendPort,
      ...(name && { name }),
      ...(hosts.length > 0 && { hosts }),
      ...(fields.backendPath && backendPath && { backend_path: backendPath }),
      ...(fields.routing && {
        strip_listen_path: stripListenPath,
        preserve_host_header: preserveHostHeader,
        auth_mode: authMode,
        allowed_methods: restrictMethods
          ? allowedMethods as ProxyCreate["allowed_methods"]
          : null,
        ...(allowedWsOrigins.length > 0 && { allowed_ws_origins: allowedWsOrigins }),
        ...(wsIdleTimeout !== "" && {
          websocket_idle_timeout_seconds: Number(wsIdleTimeout),
        }),
      }),
      // Edge reads these only for HTTP-family proxies and requires a stream
      // proxy to send false and "stream".
      allow_path_parameters: fields.routing && allowPathParameters,
      response_body_mode: fields.routing ? responseBodyMode : "stream",
      backend_connect_timeout_ms: Number(connectTimeout),
      ...(fields.ioTimeouts && {
        backend_read_timeout_ms: Number(readTimeout),
        backend_write_timeout_ms: Number(writeTimeout),
      }),
      frontend_tls: frontendTls,
      // Edge refuses passthrough on HTTP-family proxies.
      passthrough: fields.passthrough && passthrough,
      // Edge refuses `false` without backend TLS; an omitted value would keep
      // the stored one on update, so the default is sent instead.
      backend_tls_verify_server_cert: !fields.backendTls || backendTlsVerify,
      ...(fields.backendTls && {
        ...(backendTlsCertPath && { backend_tls_client_cert_path: backendTlsCertPath }),
        ...(backendTlsKeyPath && { backend_tls_client_key_path: backendTlsKeyPath }),
        ...(backendTlsCaPath && { backend_tls_server_ca_cert_path: backendTlsCaPath }),
      }),
      ...(upstreamId && { upstream_id: upstreamId }),
      ...(fields.upstreamSubset && upstreamId && upstreamSubset && { upstream_subset: upstreamSubset }),
      ...(dnsOverride && { dns_override: dnsOverride }),
      ...(dnsCacheTtl !== "" && { dns_cache_ttl_seconds: Number(dnsCacheTtl) }),
      ...(fields.circuitBreaker && cbEnabled && { circuit_breaker: buildCircuitBreaker() }),
      ...(fields.retry && retryEnabled && { retry: buildRetry() }),
      ...(fields.connectionPool && {
        ...(poolIdleTimeout !== "" && { pool_idle_timeout_seconds: Number(poolIdleTimeout) }),
        ...(poolKeepAlive !== null && { pool_enable_http_keep_alive: poolKeepAlive }),
        ...(poolHttp2 !== null && { pool_enable_http2: poolHttp2 }),
        ...(poolTcpKeepAlive !== "" && { pool_tcp_keepalive_seconds: Number(poolTcpKeepAlive) }),
        ...(poolH2KeepAliveInterval !== "" && { pool_http2_keep_alive_interval_seconds: Number(poolH2KeepAliveInterval) }),
        ...(poolH2KeepAliveTimeout !== "" && { pool_http2_keep_alive_timeout_seconds: Number(poolH2KeepAliveTimeout) }),
        ...(poolH2InitStreamWindow !== "" && { pool_http2_initial_stream_window_size: Number(poolH2InitStreamWindow) }),
        ...(poolH2InitConnWindow !== "" && { pool_http2_initial_connection_window_size: Number(poolH2InitConnWindow) }),
        ...(poolH2AdaptiveWindow !== null && {
          pool_http2_adaptive_window: poolH2AdaptiveWindow,
        }),
        ...(poolH2MaxFrameSize !== "" && { pool_http2_max_frame_size: Number(poolH2MaxFrameSize) }),
        ...(poolH2MaxConcurrentStreams !== "" && { pool_http2_max_concurrent_streams: Number(poolH2MaxConcurrentStreams) }),
        ...(poolMaxRequests !== "" && {
          pool_max_requests_per_connection: Number(poolMaxRequests),
        }),
      }),
      ...(fields.http3Pool && poolH3ConnsPerBackend !== "" && {
        pool_http3_connections_per_backend: Number(poolH3ConnsPerBackend),
      }),
      ...(listenPort !== "" && { listen_port: Number(listenPort) }),
      ...(fields.tcpIdleTimeout && tcpIdleTimeout !== "" && {
        tcp_idle_timeout_seconds: Number(tcpIdleTimeout),
      }),
      // Sent for every scheme as before; a cleared value is only rejected
      // where the field is shown (UDP/DTLS) and is otherwise omitted.
      ...(udpIdleTimeout !== "" && { udp_idle_timeout_seconds: udpIdleTimeout }),
      ...(fields.streamProxyProtocol && streamProxyProtocol && { stream_proxy_protocol: true }),
      ...(fields.backendProxyProtocol && backendProxyProtocol && { backend_proxy_protocol: "v2" as const }),
      ...(fields.udpSession && udpAmplificationFactor !== "" && {
        udp_max_response_amplification_factor: Number(udpAmplificationFactor),
      }),
    };

    await onSubmit(data);
  };

  /* ---------- Helpers for optional number inputs ---------- */

  const numVal = numberDraftText;
  const setNum = (setter: (v: NumberDraft) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(numberDraftFromInput(e.target.value));
  };

  /* ---------- Section visibility ---------- */

  const showListenPath = fields.listenPath;
  // Hosts double as SNI route predicates for opaque stream listeners.
  const showHosts = true;
  const showBackendPath = fields.backendPath;
  const showRoutingOptions = fields.routing;
  const showConnectionPool = fields.connectionPool;
  const showCircuitBreaker = fields.circuitBreaker;
  const showRetry = fields.retry;
  const showProtocolSection = true;

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-0">
      <ReadOnlySurface verdict={capability}>
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
              helpText={
                isStream
                  ? "Raw L4 stream proxy — bind a Listen Port (Protocol-Specific section); hosts act as SNI matchers on TLS-capable listeners."
                  : "gRPC and WebSocket are auto-detected per request — no separate scheme needed."
              }
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
            {/* No native `required`: a proxy may reference an upstream instead
                of a direct backend host, and validate() shows styled errors. */}
            <Input
              label="Backend Host"
              value={backendHost}
              onChange={(e) => setBackendHost(e.target.value)}
              placeholder="upstream.example.com"
              error={errors.backend_host}
              helpText={
                upstreamId.trim()
                  ? "Optional while an upstream is linked (see Upstream section)."
                  : undefined
              }
            />
            <Input
              label="Backend Port"
              type="number"
              value={numVal(backendPort)}
              onChange={setNum(setBackendPort)}
              placeholder="80"
              error={errors.backend_port}
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
          <CollapsibleSection
            title="Routing Options"
            {...collapsible.sectionProps("routing")}
          >
            <Checkbox label="Strip listen path" checked={stripListenPath} onChange={setStripListenPath} />
            <Checkbox label="Preserve host header" checked={preserveHostHeader} onChange={setPreserveHostHeader} />
            <Checkbox
              label="Allow semicolon path parameters"
              checked={allowPathParameters}
              onChange={setAllowPathParameters}
            />
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
            <Checkbox
              label="Restrict HTTP methods"
              checked={restrictMethods}
              onChange={setRestrictMethods}
            />
            {restrictMethods && (
              <MethodCheckboxGroup
                label="Allowed Methods"
                selected={allowedMethods}
                onChange={setAllowedMethods}
                options={ALL_HTTP_METHODS}
                error={errors.allowed_methods}
              />
            )}
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
        <CollapsibleSection
          title="Backend Timeouts"
          {...collapsible.sectionProps("timeouts")}
        >
          <Input
            label="Connect Timeout (ms)"
            type="number"
            value={numVal(connectTimeout)}
            onChange={setNum(setConnectTimeout)}
            error={errors.connect_timeout}
          />
          {fields.ioTimeouts ? (
            <>
              <Input
                label="Read Timeout (ms)"
                type="number"
                value={numVal(readTimeout)}
                onChange={setNum(setReadTimeout)}
                error={errors.read_timeout}
                helpText={
                  isStream
                    ? "For TCP, an inactivity timeout on the backend read direction. 0 disables it."
                    : undefined
                }
              />
              <Input
                label="Write Timeout (ms)"
                type="number"
                value={numVal(writeTimeout)}
                onChange={setNum(setWriteTimeout)}
                error={errors.write_timeout}
                helpText={
                  isStream
                    ? "For TCP, an inactivity timeout on the backend write direction. 0 disables it."
                    : undefined
                }
              />
            </>
          ) : (
            <p className="text-text-muted text-xs">
              UDP proxies use only the connect timeout; the session idle timeout is under Protocol-Specific.
            </p>
          )}
        </CollapsibleSection>

        {/* ── Section 4: TLS Settings ── */}
        <CollapsibleSection
          title="TLS Settings"
          {...collapsible.sectionProps("tls")}
        >
          <Checkbox
            label="Frontend TLS"
            checked={frontendTls}
            onChange={(v) => {
              setFrontendTls(v);
              if (v) setPassthrough(false);
            }}
            helpText="Terminate TLS on the gateway for incoming connections"
          />
          {fields.passthrough && (
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
          {fields.backendTls ? (
            <>
              <Checkbox
                label="Verify backend TLS server certificate"
                checked={backendTlsVerify}
                onChange={setBackendTlsVerify}
              />
              <p className="text-text-muted text-xs">{BACKEND_TLS_OPERATOR_SCOPE_NOTE}</p>
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
            </>
          ) : (
            <p className="text-text-muted text-xs">
              {passthrough && isStream
                ? "Passthrough forwards the client's encrypted stream, so Ferrum originates no backend TLS."
                : "Backend TLS settings apply only to https, tcps and dtls backends."}
            </p>
          )}
        </CollapsibleSection>

        {/* ── Section 5: Upstream ── */}
        <CollapsibleSection
          title="Upstream"
          badge={upstreamId ? "LINKED" : undefined}
          {...collapsible.sectionProps("upstream")}
        >
          <Input
            label="Upstream ID"
            value={upstreamId}
            onChange={(e) => setUpstreamId(e.target.value)}
            placeholder="upstream-uuid"
            helpText="Link this proxy to an upstream load-balancer group. Overrides backend host/port."
          />
          {fields.upstreamSubset && upstreamId && (
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
        <CollapsibleSection title="DNS" {...collapsible.sectionProps("dns")}>
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
        <CollapsibleSection
          title="Circuit Breaker"
          badge={cbEnabled ? "ON" : undefined}
          {...collapsible.sectionProps("circuit-breaker")}
        >
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
                value={numVal(cb.failure_threshold)}
                onChange={(e) => setCb({ ...cb, failure_threshold: numberDraftFromInput(e.target.value) })}
                error={errors.cb_failure_threshold}
              />
              <Input
                label="Success Threshold"
                type="number"
                value={numVal(cb.success_threshold)}
                onChange={(e) => setCb({ ...cb, success_threshold: numberDraftFromInput(e.target.value) })}
                error={errors.cb_success_threshold}
              />
              <Input
                label="Timeout (seconds)"
                type="number"
                value={numVal(cb.timeout_seconds)}
                onChange={(e) => setCb({ ...cb, timeout_seconds: numberDraftFromInput(e.target.value) })}
                error={errors.cb_timeout_seconds}
              />
              {fields.circuitBreakerStatusCodes && (
                <TagInput
                  label="Failure Status Codes"
                  values={cb.failure_status_codes}
                  onChange={(v) => setCb({ ...cb, failure_status_codes: v as number[] })}
                  placeholder="500, 502, 503"
                  parseAsNumber
                />
              )}
              <Input
                label="Half-Open Max Requests"
                type="number"
                value={numVal(cb.half_open_max_requests)}
                onChange={(e) => setCb({ ...cb, half_open_max_requests: numberDraftFromInput(e.target.value) })}
                error={errors.cb_half_open_max_requests}
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
        <CollapsibleSection
          title="Retry"
          badge={retryEnabled ? "ON" : undefined}
          {...collapsible.sectionProps("retry")}
        >
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
                value={numVal(retry.max_retries)}
                onChange={(e) =>
                  setRetry({ ...retry, max_retries: numberDraftFromInput(e.target.value) })
                }
                error={errors.retry_max_retries}
              />
              {fields.retryHttpMatchers ? (
                <>
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
                </>
              ) : (
                <p className="text-text-muted text-xs">
                  TCP proxies retry only the backend dial, and only with Retry on connect failure enabled.
                </p>
              )}
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
                  value={numVal(fixedDelay)}
                  onChange={setNum(setFixedDelay)}
                  error={errors.retry_fixed_delay}
                />
              ) : (
                <>
                  <Input
                    label="Base (ms)"
                    type="number"
                    value={numVal(expBase)}
                    onChange={setNum(setExpBase)}
                    error={errors.retry_exp_base}
                  />
                  <Input
                    label="Max (ms)"
                    type="number"
                    value={numVal(expMax)}
                    onChange={setNum(setExpMax)}
                    error={errors.retry_exp_max}
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
          <CollapsibleSection
            title="Connection Pool"
            {...collapsible.sectionProps("connection-pool")}
          >
            <Input
              label="Pool Idle Timeout (seconds)"
              type="number"
              value={numVal(poolIdleTimeout)}
              onChange={setNum(setPoolIdleTimeout)}
            />
            <Select
              label="HTTP Keep-Alive Override"
              value={poolKeepAlive === null ? "inherit" : String(poolKeepAlive)}
              onValueChange={(value) =>
                setPoolKeepAlive(value === "inherit" ? null : value === "true")
              }
              options={[
                { value: "inherit", label: "Inherit gateway default" },
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
            />
            <Select
              label="HTTP/2 Override"
              value={poolHttp2 === null ? "inherit" : String(poolHttp2)}
              onValueChange={(value) =>
                setPoolHttp2(value === "inherit" ? null : value === "true")
              }
              options={[
                { value: "inherit", label: "Inherit gateway default" },
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
            />
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
            <Select
              label="HTTP/2 Adaptive Window Override"
              value={poolH2AdaptiveWindow === null ? "inherit" : String(poolH2AdaptiveWindow)}
              onValueChange={(value) =>
                setPoolH2AdaptiveWindow(value === "inherit" ? null : value === "true")
              }
              options={[
                { value: "inherit", label: "Inherit gateway default" },
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
            />
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
            <Input
              label="Max Requests per Connection"
              type="number"
              value={numVal(poolMaxRequests)}
              onChange={setNum(setPoolMaxRequests)}
              helpText="Leave blank to inherit the gateway default."
            />
          </CollapsibleSection>
        )}

        {/* ── Section 10: Protocol-Specific ── */}
        {showProtocolSection && (
          <CollapsibleSection
            title="Protocol-Specific"
            badge={backendScheme.toUpperCase()}
            {...collapsible.sectionProps("protocol")}
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
            {fields.tcpIdleTimeout && (
              <Input
                label="TCP Idle Timeout (seconds)"
                type="number"
                value={numVal(tcpIdleTimeout)}
                onChange={setNum(setTcpIdleTimeout)}
              />
            )}
            {fields.udpSession && (
              <>
                <Input
                  label="UDP Idle Timeout (seconds)"
                  type="number"
                  value={numVal(udpIdleTimeout)}
                  onChange={setNum(setUdpIdleTimeout)}
                  error={errors.udp_idle_timeout}
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
            {fields.streamProxyProtocol && (
              <Checkbox
                label="Inbound PROXY protocol"
                checked={streamProxyProtocol}
                onChange={setStreamProxyProtocol}
                helpText="Read PROXY protocol v1/v2 headers from a trusted load balancer to recover client IPs."
              />
            )}
            {fields.backendProxyProtocol && (
              <Checkbox
                label="Outbound PROXY protocol v2 to backend"
                checked={backendProxyProtocol}
                onChange={setBackendProxyProtocol}
                helpText="Prepend a PROXY v2 header on backend connects so backends see the client IP."
              />
            )}
            {fields.http3Pool && (
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
      </ReadOnlySurface>

      {/* ── Actions ── */}
      <div className="flex flex-col items-end gap-3 pt-6">
        {collapsible.showSummary && (
          <FormValidationSummary count={collapsible.errorCount} />
        )}
        <div className="flex items-center justify-end gap-3 w-full">
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate({ to: "/proxies" })}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" loading={isLoading} disabled={readOnly}>
          {isEdit ? "Update Proxy" : "Create Proxy"}
        </Button>
        </div>
      </div>
    </form>
  );
}
