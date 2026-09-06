import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { AuthProvider, useAuth, type AuthPrincipal } from "./auth";

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({
  api: transport,
  setCsrfToken: vi.fn(),
  setOnUnauthorized: vi.fn(),
  SILENT_ERRORS: "silentErrors",
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let auth: ReturnType<typeof useAuth>;
let mounts = 0;

// A form can copy query data into local state only once. Clearing the cache
// alone must not leave that old value visible after authorization changes.
function Workspace() {
  const value = useAuth();
  const queryClient = useQueryClient();
  const [mount] = useState(() => ++mounts);
  const [snapshot] = useState(() => queryClient.getQueryData<string>(["privileged"]) ?? "empty");
  useEffect(() => { auth = value; });
  return <span data-mount={mount}>{snapshot}</span>;
}

describe("session authorization refresh", () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;
  let nextPrincipal: AuthPrincipal;

  beforeEach(async () => {
    mounts = 0;
    nextPrincipal = {
      subject: "same-user",
      displayName: "Original name",
      role: "admin",
      namespaces: ["tenant-a", "tenant-b"],
      authMode: "trusted-proxy",
    };
    transport.get.mockImplementation((path: string) => ({
      json: async () => path === "api/auth/config"
        ? { mode: "trusted-proxy" }
        : { principal: nextPrincipal, csrfToken: "csrf" },
    }));
    transport.post.mockReturnValue({ json: async () => ({}) });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["privileged"], "old-admin-settings");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider><Workspace /></AuthProvider>
        </QueryClientProvider>,
      );
    });
    expect(auth.status).toBe("authenticated");
    expect(host.textContent).toBe("old-admin-settings");
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    host.remove();
    vi.clearAllMocks();
  });

  it.each<[string, Partial<AuthPrincipal>]>([
    ["role downgrade", { role: "viewer" }],
    ["namespace revocation", { namespaces: ["tenant-a"] }],
    ["all namespace grants revoked", { namespaces: [] }],
    ["subject change", { subject: "another-user" }],
    ["authentication mode change", { authMode: "static" }],
  ])("clears cached data and mounted form state on %s", async (_description, change) => {
    const previousMount = host.querySelector("span")!.dataset.mount;
    nextPrincipal = { ...nextPrincipal, ...change };
    await act(async () => { await auth.refreshSession(); });
    expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    expect(host.textContent).toBe("empty");
    expect(host.querySelector("span")!.dataset.mount).not.toBe(previousMount);
    expect(auth.principal).toEqual(nextPrincipal);
  });

  it("preserves cached data and forms for equivalent grants and display-name changes", async () => {
    const previousMount = host.querySelector("span")!.dataset.mount;
    nextPrincipal = {
      ...nextPrincipal,
      namespaces: ["tenant-b", "tenant-a", "tenant-a"],
      displayName: "Updated name",
    };
    await act(async () => { await auth.refreshSession(); });
    expect(queryClient.getQueryData(["privileged"])).toBe("old-admin-settings");
    expect(host.textContent).toBe("old-admin-settings");
    expect(host.querySelector("span")!.dataset.mount).toBe(previousMount);
    expect(auth.principal?.displayName).toBe("Updated name");
  });

  it("distinguishes unrestricted namespaces from an empty grant set", async () => {
    nextPrincipal = { ...nextPrincipal, namespaces: undefined };
    await act(async () => { await auth.refreshSession(); });
    queryClient.setQueryData(["privileged"], "unrestricted-data");
    nextPrincipal = { ...nextPrincipal, namespaces: [] };
    await act(async () => { await auth.refreshSession(); });
    expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
  });

  it("discards cached data and mounted form state on logout", async () => {
    await act(async () => { await auth.logout(); });
    expect(auth.status).toBe("unauthenticated");
    expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    expect(host.textContent).toBe("empty");
  });
});
