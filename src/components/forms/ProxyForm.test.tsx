import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFormUpdatePayload } from "@/api/proxies";
import type { Proxy, ProxyCreate } from "@/api/types";
import { clearText, inputByLabel, inputByLabelOrNull, typeText } from "@/test/fields";
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
