/* ------------------------------------------------------------------ */
/*  A refused concurrent save keeps the draft and never resends it     */
/*  (issue #381).                                                      */
/* ------------------------------------------------------------------ */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleResourceError } from "@/api/conditionalWrite";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import type { Proxy } from "@/api/types";
import { inputByLabel } from "@/test/fields";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ proxyId: "checkout" }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/shared/ProxyApiSpecsCard", () => ({
  ProxyApiSpecsCard: () => null,
}));
vi.mock("@/stores/capabilities", () => ({
  useCapabilities: () => ({
    capabilities: { proxies: { allowed: true, reason: null } },
  }),
}));
vi.mock("@/hooks/usePlugins", () => ({
  useAllPluginConfigs: () => emptyQuery([]),
}));
vi.mock("@/hooks/useConsumers", () => ({
  useAllConsumers: () => emptyQuery([]),
}));
vi.mock("@/hooks/useUpstreams", () => ({
  useUpstream: () => emptyQuery(undefined),
}));

function emptyQuery<T>(data: T) {
  return {
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    dataUpdatedAt: 1,
    refetch: async () => ({ data }),
  };
}

const GATEWAY_HOST = "backend-b.internal";
const OPENED_HOST = "backend-a.internal";

function proxyAt(host: string): Proxy {
  return {
    id: "checkout",
    namespace: "tenant-a",
    name: "checkout",
    hosts: [],
    listen_path: "/checkout",
    backend_scheme: "https",
    backend_host: host,
    backend_port: 8443,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 2000,
    backend_read_timeout_ms: 5000,
    backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 30,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** What the detail query currently returns; the refetch advances it. */
let served: Proxy = proxyAt(OPENED_HOST);
const refetch = vi.fn(async () => {
  served = proxyAt(GATEWAY_HOST);
  return { data: served };
});

const mutateAsync = vi.fn();
vi.mock("@/hooks/useProxies", () => ({
  useProxy: () => ({
    data: served,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    dataUpdatedAt: 1,
    refetch,
  }),
  useUpdateProxy: () => ({ mutateAsync, isPending: false }),
  useDeleteProxy: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
  }),
}));

const { default: ProxyDetailPage } = await import("./$proxyId");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <NamespaceProvider>
        <ProxyDetailPage />
      </NamespaceProvider>,
    );
  });
}

function setField(label: string, value: string) {
  const field = inputByLabel(host, label);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return act(async () => found!.click());
}

function dialogText(): string {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog?.textContent ?? "";
}

describe("a proxy save refused as stale", () => {
  beforeEach(() => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    served = proxyAt(OPENED_HOST);
    refetch.mockClear();
    mutateAsync.mockReset();
    mutateAsync.mockRejectedValue(
      new StaleResourceError({
        resource: "proxy",
        id: "checkout",
        namespace: "tenant-a",
        original: { backend_host: OPENED_HOST, backend_read_timeout_ms: 5000 },
        current: { backend_host: GATEWAY_HOST, backend_read_timeout_ms: 5000 },
        proposed: { backend_host: OPENED_HOST, backend_read_timeout_ms: 30000 },
      }),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it("keeps the draft, explains the conflict, and offers no silent reapply", async () => {
    await render();

    setField("Backend Host", "typed-by-operator.internal");
    await clickButton("Update Proxy");

    // The conflict is on screen with all three sides of the comparison.
    const text = dialogText();
    expect(text).toContain("This proxy changed after you opened it");
    expect(text).toContain(OPENED_HOST);
    expect(text).toContain(GATEWAY_HOST);
    expect(text).toContain("30000");

    // The operator's unsaved value is exactly where they left it.
    expect(inputByLabel(host, "Backend Host").value).toBe(
      "typed-by-operator.internal",
    );

    // There is deliberately no control that resends the refused body.
    const dialog = document.querySelector('[role="dialog"]')!;
    const choices = [...dialog.querySelectorAll("button")]
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label));
    expect(choices).toEqual(["Discard my draft and reload", "Keep my draft"]);

    // And nothing was resent on our behalf.
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("returns to the untouched draft on Keep my draft", async () => {
    await render();
    setField("Backend Host", "typed-by-operator.internal");
    await clickButton("Update Proxy");

    await clickButton("Keep my draft");

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(inputByLabel(host, "Backend Host").value).toBe(
      "typed-by-operator.internal",
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("reseeds the form from the gateway on an explicit discard", async () => {
    await render();
    setField("Backend Host", "typed-by-operator.internal");
    await clickButton("Update Proxy");

    await clickButton("Discard my draft and reload");

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The remounted form shows what the other administrator actually saved.
    expect(inputByLabel(host, "Backend Host").value).toBe(GATEWAY_HOST);
  });
});
