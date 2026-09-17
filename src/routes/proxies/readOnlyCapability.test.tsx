/* ------------------------------------------------------------------ */
/*  A viewer session and a file-mode gateway must present the proxy    */
/*  create and update surfaces read-only, with the reason visible      */
/*  before any field is edited (issue #359).                           */
/* ------------------------------------------------------------------ */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, Proxy, ProxyCreate } from "@/api/types";
import { ProxyForm } from "@/components/forms/ProxyForm";
import { CapabilityProvider, useCapabilities } from "@/stores/capabilities";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import ProxyNewPage from "./new";

let principal: { subject: string; displayName: string; role: "viewer" | "operator" | "admin"; authMode: "static" } | null = null;
let health: HealthResponse | undefined;

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal }) }));
vi.mock("@/hooks/useMetrics", () => ({
  useHealth: () => ({
    data: health,
    isError: false,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: health ? 1 : 0,
    error: null,
    refetch: async () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const createProxy = vi.fn(async () => ({ id: "created" }));
vi.mock("@/hooks/useProxies", () => ({
  useCreateProxy: () => ({ mutateAsync: createProxy, isPending: false }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const existingProxy: Proxy = {
  id: "proxy-1",
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
  hosts: [],
  listen_path: "/orders",
  backend_scheme: "https",
  backend_host: "orders.internal",
  backend_port: 8443,
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

let host: HTMLDivElement;
let root: Root;

function writableAdmin() {
  principal = { subject: "ops", displayName: "Ops", role: "admin", authMode: "static" };
  health = { status: "ok", ready: true, mode: "database", admin_writes_enabled: true };
}

async function renderPage(node: ReactNode) {
  await act(async () => {
    root.render(
      <NamespaceProvider>
        <CapabilityProvider>{node}</CapabilityProvider>
      </NamespaceProvider>,
    );
  });
}

async function submitForm() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

function readOnlyNotice(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-capability-blocked]');
}

beforeEach(() => {
  createProxy.mockClear();
  writableAdmin();
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
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
  localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("Create Proxy capability presentation", () => {
  it("stays editable for an operator on a writable gateway", async () => {
    principal = { subject: "ops", displayName: "Ops", role: "operator", authMode: "static" };
    await renderPage(<ProxyNewPage />);

    expect(readOnlyNotice()).toBeNull();
    expect(host.querySelector("fieldset[disabled]")).toBeNull();
  });

  it("explains the viewer role before the form is edited and refuses to submit", async () => {
    principal = { subject: "read-only", displayName: "Read Only", role: "viewer", authMode: "static" };
    await renderPage(<ProxyNewPage />);

    const notice = readOnlyNotice();
    expect(notice?.getAttribute("data-capability-blocked")).toBe("role");
    expect(notice?.textContent).toContain("Proxy configuration is read-only");
    expect(notice?.textContent).toContain("viewer role");
    expect(notice?.textContent).toContain("operator role");
    // The explanation is visible text, not only a disabled attribute.
    expect(host.querySelector("fieldset[disabled]")).not.toBeNull();

    await submitForm();
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("explains a file-mode gateway to an admin session", async () => {
    health = { status: "ok", ready: true, mode: "file", admin_writes_enabled: false };
    await renderPage(<ProxyNewPage />);

    const notice = readOnlyNotice();
    expect(notice?.getAttribute("data-capability-blocked")).toBe("gateway-read-only");
    expect(notice?.textContent).toContain("file mode");

    await submitForm();
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("concludes nothing while the health snapshot has not been read", async () => {
    health = undefined;
    await renderPage(<ProxyNewPage />);

    expect(readOnlyNotice()).toBeNull();
    expect(host.querySelector("fieldset[disabled]")).toBeNull();
  });
});

describe("Update Proxy capability presentation", () => {
  const submit = vi.fn(async (_data: ProxyCreate) => {});

  beforeEach(() => submit.mockClear());

  it("renders the editor read-only with the gateway-mode reason", async () => {
    health = { status: "ok", ready: true, mode: "file" };
    await renderPage(
      <ProxyFormUnderCapability initialData={existingProxy} onSubmit={submit} />,
    );

    const notice = readOnlyNotice();
    expect(notice?.textContent).toContain("file mode");
    expect(host.querySelector("fieldset[disabled]")).not.toBeNull();
    expect(host.textContent).toContain("Update Proxy");

    await submitForm();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits normally once the gateway accepts writes", async () => {
    await renderPage(
      <ProxyFormUnderCapability initialData={existingProxy} onSubmit={submit} />,
    );

    expect(readOnlyNotice()).toBeNull();
    await submitForm();
    expect(submit).toHaveBeenCalledOnce();
  });
});

/**
 * Stands in for the proxy detail route: it resolves the same capability from
 * the provider and passes it to the same form the route renders.
 */
function ProxyFormUnderCapability({
  initialData,
  onSubmit,
}: {
  initialData: Proxy;
  onSubmit: (data: ProxyCreate) => Promise<void>;
}) {
  const { capabilities } = useCapabilities();
  return (
    <ProxyForm
      initialData={initialData}
      onSubmit={onSubmit}
      isLoading={false}
      capability={capabilities.proxies}
    />
  );
}
