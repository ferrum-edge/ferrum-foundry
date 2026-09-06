import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY, useNamespace } from "@/stores/namespace";
import { Header } from "./Header";

const { list, auth } = vi.hoisted(() => ({
  list: vi.fn(),
  auth: { principal: { namespaces: undefined as string[] | undefined } },
}));
vi.mock("@/api/namespaces", () => ({ list }));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ ...auth, logout: vi.fn() }) }));
vi.mock("@/stores/theme", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }),
}));
vi.mock("@/hooks/useBffHealth", () => ({
  useBffReadiness: () => ({ data: { status: "ready" } }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: ReturnType<typeof useNamespace>;
function Probe() {
  const value = useNamespace();
  useEffect(() => { current = value; });
  return <span data-testid="scope">{value.scope.namespace}</span>;
}
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NamespaceProvider>
          <Header onToggleSidebar={() => {}} />
          <Probe />
        </NamespaceProvider>
      </QueryClientProvider>,
    );
  });
}
function combobox(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}
async function waitFor(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  list.mockReset();
  auth.principal.namespaces = undefined;
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "retired");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  localStorage.removeItem(NAMESPACE_STORAGE_KEY);
});

describe("Header namespace registry reconciliation", () => {
  it("retains the pending selection then persists the first available namespace", async () => {
    let resolve!: (names: string[]) => void;
    list.mockImplementation(() => new Promise<string[]>((done) => { resolve = done; }));
    await mount();
    expect(combobox().textContent).toContain("retired");
    expect(current.scope.namespace).toBe("retired");
    await act(async () => { resolve(["active", "other"]); });
    await waitFor(() => expect(current.scope.namespace).toBe("active"));
    expect(combobox().textContent).toContain("active");
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("active");
    expect(list).toHaveBeenCalledWith({ namespace: "retired" });
  });

  it("chooses a grant-allowed namespace instead of the first global registry name", async () => {
    auth.principal.namespaces = ["retired", "allowed"];
    list.mockResolvedValue(["ungranted", "allowed"]);
    await mount();
    await waitFor(() => expect(current.scope.namespace).toBe("allowed"));
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("allowed");
  });

  it("reconciles a later successful refresh after a rename or deletion", async () => {
    list.mockResolvedValue(["retired", "other"]);
    await mount();
    await waitFor(() => expect(client.getQueryState(["namespaces"])?.status).toBe("success"));
    expect(current.scope.namespace).toBe("retired");
    list.mockResolvedValue(["renamed", "other"]);
    await act(async () => { await client.refetchQueries({ queryKey: ["namespaces"] }); });
    await waitFor(() => expect(current.scope.namespace).toBe("renamed"));
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("renamed");
  });

  it("keeps the current binding when the registry is unavailable", async () => {
    list.mockRejectedValue(new Error("registry unavailable"));
    await mount();
    await waitFor(() => expect(client.getQueryState(["namespaces"])?.status).toBe("error"));
    expect(current.scope.namespace).toBe("retired");
    expect(combobox().textContent).toContain("retired");
  });

  it("shows an empty registry without inventing a selectable namespace", async () => {
    list.mockResolvedValue([]);
    await mount();
    await waitFor(() => expect(combobox().disabled).toBe(true));
    expect(combobox().textContent).toContain("No namespaces available");
    expect(combobox().textContent).not.toContain("retired");
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("retired");
  });
});
