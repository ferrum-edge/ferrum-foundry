import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proxy, ProxyCreate } from "@/api/types";
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
