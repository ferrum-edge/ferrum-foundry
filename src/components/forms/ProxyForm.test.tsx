import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFormUpdatePayload } from "@/api/proxies";
import type { Proxy, ProxyCreate } from "@/api/types";
import { clearText, inputByLabel, inputByLabelOrNull, typeText } from "@/test/fields";
import { selectOption } from "@/test/__tests__/harness";
import { ProxyForm } from "./ProxyForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const submit = vi.fn(async (_data: ProxyCreate) => {});

beforeEach(() => {
  submit.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function renderForm(initialData?: Proxy) {
  await act(async () => {
    root.render(
      <ProxyForm initialData={initialData} onSubmit={submit} isLoading={false} />,
    );
  });
}

async function save() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

const streamProxy: Proxy = {
  id: "proxy-1",
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
  hosts: [],
  allow_path_parameters: false,
  backend_scheme: "tcp",
  backend_host: "backend",
  backend_port: 8080,
  strip_listen_path: true,
  preserve_host_header: false,
  backend_connect_timeout_ms: 5000,
  backend_read_timeout_ms: 30000,
  backend_write_timeout_ms: 30000,
  backend_tls_verify_server_cert: true,
  auth_mode: "single",
  plugins: [],
  frontend_tls: false,
  passthrough: false,
  udp_idle_timeout_seconds: 60,
  allowed_ws_origins: [],
  response_body_mode: "stream",
  listen_port: null,
};

describe("ProxyForm collapsed validation", () => {
  it("shows listen port errors when Protocol-Specific stays collapsed", async () => {
    await renderForm(streamProxy);
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Stream proxies must bind a listen port");
    expect(host.textContent).toContain("Fix 1 validation error above");
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute("aria-invalid")).toBe("true");
    expect(active?.closest("form")).toBe(host.querySelector("form"));
  });

  it("submits a stream proxy when listen port is set", async () => {
    await renderForm({ ...streamProxy, listen_port: 9100 });
    await save();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      backend_scheme: "tcp",
      listen_port: 9100,
    });
  });
});

describe("ProxyForm listen path round-trip (#447)", () => {
  it.each(["http", "https"] as const)(
    "preserves a host-only %s proxy without adding a root listen path",
    async (backendScheme) => {
      await renderForm({
        ...httpProxy,
        backend_scheme: backendScheme,
        listen_path: null,
        hosts: ["api.example.test"],
      });
      await save();
      const payload = mergeFormUpdatePayload(
        { ...httpProxy, backend_scheme: backendScheme, listen_path: null },
        submitted(),
      );
      expect(payload.listen_path).toBeNull();
      expect(payload.backend_path).toBeNull();
      expect(payload.dns_override).toBeNull();
      expect(payload.pool_idle_timeout_seconds).toBeNull();
    },
  );

  it("keeps an absent listen path host-only when editing an existing proxy", async () => {
    const { listen_path: _listenPath, ...hostOnlyProxy } = httpProxy;
    await renderForm({ ...hostOnlyProxy, hosts: ["api.example.test"] });
    await save();
    expect(
      mergeFormUpdatePayload(hostOnlyProxy, submitted()).listen_path,
    ).toBeNull();
  });

  it("defaults a new proxy to the root listen path", async () => {
    await renderForm();
    expect(inputByLabel(host, "Listen Path").value).toBe("/");
  });
});

describe("ProxyForm path parameter setting", () => {
  it("loads and submits the Edge path parameter setting", async () => {
    await renderForm({ ...httpProxy, allow_path_parameters: true });
    await toggleSection("Routing Options");
    const checkbox = inputByLabel(host, "Allow semicolon path parameters");
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    await save();
    expect(submitted().allow_path_parameters).toBe(false);
  });

  it("never sends path parameters for a stream proxy", async () => {
    await renderForm({ ...streamProxy, listen_port: 9100, allow_path_parameters: true });
    expect(host.textContent).not.toContain("Allow semicolon path parameters");
    await save();
    expect(submitted().allow_path_parameters).toBe(false);
  });
});

const httpProxy: Proxy = {
  ...streamProxy,
  backend_scheme: "http",
  listen_path: "/api",
};

async function toggleSection(title: string) {
  const section = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(title),
  )!;
  await act(async () => section.click());
}

function submitted(): ProxyCreate {
  expect(submit).toHaveBeenCalledOnce();
  return submit.mock.calls[0]![0];
}

describe("ProxyForm numeric drafts (#402)", () => {
  it("clears and replaces the backend port without inserting 0", async () => {
    await renderForm(httpProxy);
    const port = inputByLabel(host, "Backend Port");
    expect(port.value).toBe("8080");
    await clearText(port);
    expect(port.value).toBe("");

    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(port.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Backend port is required");

    await typeText(port, "9090");
    expect(port.value).toBe("9090");
    await save();
    expect(submitted()).toMatchObject({
      backend_port: 9090,
      backend_connect_timeout_ms: 5000,
      backend_read_timeout_ms: 30000,
      backend_write_timeout_ms: 30000,
      udp_idle_timeout_seconds: 60,
    });
  });

  it("sends the documented 0 for an empty port on an upstream-linked proxy", async () => {
    await renderForm({ ...httpProxy, upstream_id: "orders-pool" });
    await clearText(inputByLabel(host, "Backend Port"));
    await save();
    expect(submitted()).toMatchObject({ upstream_id: "orders-pool", backend_port: 0 });
  });

  it("reopens Backend Timeouts for a cleared timeout and blocks submit", async () => {
    await renderForm(httpProxy);
    await toggleSection("Backend Timeouts");
    const connect = inputByLabel(host, "Connect Timeout (ms)");
    await clearText(connect);
    expect(connect.value).toBe("");
    await toggleSection("Backend Timeouts");
    expect(inputByLabelOrNull(host, "Connect Timeout (ms)")).toBeNull();

    await save();
    expect(submit).not.toHaveBeenCalled();
    const reopened = inputByLabel(host, "Connect Timeout (ms)");
    expect(reopened.value).toBe("");
    expect(reopened.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Connect timeout is required");

    await typeText(reopened, "2500");
    await save();
    expect(submitted().backend_connect_timeout_ms).toBe(2500);
  });

  it("clears and retypes circuit-breaker and retry settings", async () => {
    await renderForm({
      ...httpProxy,
      circuit_breaker: {
        failure_threshold: 5,
        success_threshold: 3,
        timeout_seconds: 30,
        failure_status_codes: [500],
        half_open_max_requests: 1,
        trip_on_connection_errors: true,
      },
      retry: {
        max_retries: 3,
        retryable_status_codes: [503],
        retryable_methods: ["GET"],
        backoff: { fixed: { delay_ms: 100 } },
        retry_on_connect_failure: true,
      },
    });
    await toggleSection("Circuit Breaker");
    await toggleSection("Retry");

    const failures = inputByLabel(host, "Failure Threshold");
    const retries = inputByLabel(host, "Max Retries");
    const delay = inputByLabel(host, "Delay (ms)");
    for (const field of [failures, retries, delay]) {
      await clearText(field);
      expect(field.value).toBe("");
    }
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Failure threshold is required");
    expect(host.textContent).toContain("Max retries is required");
    expect(host.textContent).toContain("Delay is required");

    await typeText(failures, "7");
    await typeText(retries, "0");
    await typeText(delay, "250");
    await save();
    const data = submitted();
    expect(data.circuit_breaker?.failure_threshold).toBe(7);
    expect(data.retry).toMatchObject({ max_retries: 0, backoff: { fixed: { delay_ms: 250 } } });
  });
});

describe("ProxyForm method restriction", () => {
  it("refuses an empty restriction inline instead of sending allowed_methods: []", async () => {
    await renderForm({ ...httpProxy, allowed_methods: [] as unknown as Proxy["allowed_methods"] });
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Select at least one method");
  });

  it("sends a non-empty restriction and null when unrestricted", async () => {
    await renderForm({ ...httpProxy, allowed_methods: ["GET"] as Proxy["allowed_methods"] });
    await save();
    expect(submitted().allowed_methods).toEqual(["GET"]);
    submit.mockClear();
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderForm({ ...httpProxy, allowed_methods: null });
    await save();
    expect(submitted().allowed_methods).toBeNull();
  });
});

describe("ProxyForm per-scheme fields (#655)", () => {
  const breaker = {
    failure_threshold: 5,
    success_threshold: 3,
    timeout_seconds: 30,
    failure_status_codes: [500],
    half_open_max_requests: 1,
    trip_on_connection_errors: true,
  };
  const retry = {
    max_retries: 2,
    retryable_status_codes: [503],
    retryable_methods: ["GET"],
    backoff: { fixed: { delay_ms: 100 } },
    retry_on_connect_failure: true,
  };
  // Every HTTP-only setting filled in, plus an empty method restriction that
  // the HTTP form refuses.
  const tunedHttpProxy: Proxy = {
    ...httpProxy,
    listen_port: 9100,
    backend_path: "/v2",
    preserve_host_header: true,
    auth_mode: "multi",
    response_body_mode: "buffer",
    allowed_methods: [] as unknown as Proxy["allowed_methods"],
    allowed_ws_origins: ["https://app.example.test"],
    websocket_idle_timeout_seconds: 120,
    upstream_id: "orders-pool",
    upstream_subset: "v2",
    circuit_breaker: breaker,
    retry,
    pool_idle_timeout_seconds: 30,
    pool_enable_http_keep_alive: true,
    pool_enable_http2: true,
    pool_tcp_keepalive_seconds: 60,
    pool_http2_keep_alive_interval_seconds: 10,
    pool_http2_max_concurrent_streams: 100,
    pool_max_requests_per_connection: 1000,
  };
  const httpOnlyKeys = [
    "listen_path",
    "backend_path",
    "strip_listen_path",
    "preserve_host_header",
    "auth_mode",
    "allowed_methods",
    "allowed_ws_origins",
    "websocket_idle_timeout_seconds",
    "pool_idle_timeout_seconds",
    "pool_enable_http_keep_alive",
    "pool_enable_http2",
    "pool_tcp_keepalive_seconds",
    "pool_http2_keep_alive_interval_seconds",
    "pool_http2_max_concurrent_streams",
    "pool_max_requests_per_connection",
  ];
  const sectionButton = (title: string) =>
    Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(title),
    );

  it("neither validates nor sends HTTP-only settings or retry after switching to UDP", async () => {
    await renderForm({
      ...tunedHttpProxy,
      backend_read_timeout_ms: "" as unknown as number,
      retry: { ...retry, max_retries: "" as unknown as number },
    });
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Select at least one method");
    expect(host.textContent).toContain("Read timeout is required");
    expect(host.textContent).toContain("Max retries is required");

    await selectOption("Backend Scheme", "UDP (datagram)");
    for (const title of ["Routing Options", "Retry", "Connection Pool"]) {
      expect(sectionButton(title), title).toBeUndefined();
    }
    expect(inputByLabelOrNull(host, "Read Timeout (ms)")).toBeNull();
    expect(inputByLabelOrNull(host, "Upstream Subset")).toBeNull();
    await save();
    const payload = submitted();
    for (const key of [
      ...httpOnlyKeys,
      "retry",
      "backend_read_timeout_ms",
      "backend_write_timeout_ms",
      "upstream_subset",
    ]) {
      expect(payload, key).not.toHaveProperty(key);
    }
    // Edge's UDP relay consults the breaker on every backend dial.
    expect(payload).toMatchObject({
      backend_scheme: "udp",
      response_body_mode: "stream",
      allow_path_parameters: false,
      listen_port: 9100,
      upstream_id: "orders-pool",
      circuit_breaker: breaker,
    });
    const update = mergeFormUpdatePayload(tunedHttpProxy, payload);
    expect(update).toMatchObject({
      allowed_methods: null,
      backend_path: null,
      retry: null,
      upstream_subset: null,
      pool_idle_timeout_seconds: null,
      websocket_idle_timeout_seconds: null,
      allowed_ws_origins: [],
      response_body_mode: "stream",
    });
  });

  it("keeps the circuit breaker, retry and I/O timeouts TCP uses and drops the rest", async () => {
    await renderForm(tunedHttpProxy);
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Select at least one method");

    await selectOption("Backend Scheme", "TCP (raw stream)");
    expect(sectionButton("Routing Options")).toBeUndefined();
    expect(sectionButton("Connection Pool")).toBeUndefined();
    expect(sectionButton("Retry")).toBeDefined();
    await save();
    const payload = submitted();
    for (const key of httpOnlyKeys) expect(payload, key).not.toHaveProperty(key);
    expect(payload).toMatchObject({
      backend_scheme: "tcp",
      response_body_mode: "stream",
      backend_read_timeout_ms: 30000,
      backend_write_timeout_ms: 30000,
      upstream_subset: "v2",
      circuit_breaker: breaker,
      retry,
    });
    expect(mergeFormUpdatePayload(tunedHttpProxy, payload).allowed_methods).toBeNull();
  });

  it("validates the circuit breaker a TCP proxy uses, without HTTP status codes", async () => {
    await renderForm({
      ...streamProxy,
      listen_port: 9100,
      circuit_breaker: { ...breaker, failure_threshold: "" as unknown as number },
    });
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Failure threshold is required");
    expect(inputByLabel(host, "Failure Threshold").value).toBe("");
    expect(host.textContent).not.toContain("Failure Status Codes");
  });

  it("drops stream-only settings after switching a TCP proxy to HTTPS", async () => {
    await renderForm({
      ...streamProxy,
      hosts: ["api.example.test"],
      listen_port: 9100,
      passthrough: true,
      tcp_idle_timeout_seconds: 30,
      stream_proxy_protocol: true,
      backend_proxy_protocol: "v2",
    });
    await selectOption("Backend Scheme", "HTTPS (REST / gRPC / WebSocket, auto H2/H3)");
    await save();
    const payload = submitted();
    expect(payload).toMatchObject({ backend_scheme: "https", passthrough: false });
    for (const key of [
      "tcp_idle_timeout_seconds",
      "stream_proxy_protocol",
      "backend_proxy_protocol",
      "udp_max_response_amplification_factor",
    ]) {
      expect(payload, key).not.toHaveProperty(key);
    }
  });
});
