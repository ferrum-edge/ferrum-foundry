import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { AuthProvider, useAuth, type AuthPrincipal } from "./auth";

import { issueRequestTicket, setCsrfToken, setOnUnauthorized } from "@/api/client";
import { getGatewayMetadataSnapshot, observeGatewayResponse, resetGatewayMetadata } from "@/api/gatewayMetadata";

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const tickets = vi.hoisted(() => ({ last: 0 }));
vi.mock("@/api/client", () => ({
  api: transport,
  issueRequestTicket: () => ++tickets.last,
  latestRequestTicket: () => tickets.last,
  REQUEST_TICKET: "requestTicket",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Hold the next session read open until the test completes it. */
function holdSessionRead() {
  const held = deferred<unknown>();
  transport.get.mockImplementationOnce(() => ({ json: () => held.promise }));
  return held;
}

function unauthorized() {
  return Object.assign(new Error("HTTP 401"), { response: new Response(null, { status: 401 }) });
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
    await observeGatewayResponse(
      new Request("http://localhost/api/proxy/proxies/p-1", { method: "PUT", headers: { "X-Ferrum-Namespace": "tenant-b" } }),
      new Response(null, { status: 200, headers: { "X-Ferrum-Config-Cursor": "1:2" } }),
    );
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    host.remove();
    resetGatewayMetadata();
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
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
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
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "applied", namespace: "tenant-b" });
  });

  it("distinguishes unrestricted namespaces from an empty grant set", async () => {
    nextPrincipal = { ...nextPrincipal, namespaces: undefined };
    await act(async () => { await auth.refreshSession(); });
    queryClient.setQueryData(["privileged"], "unrestricted-data");
    nextPrincipal = { ...nextPrincipal, namespaces: [] };
    await act(async () => { await auth.refreshSession(); });
    expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
  });

  it("discards cached data and mounted form state on logout", async () => {
    await act(async () => { await auth.logout(); });
    expect(auth.status).toBe("unauthenticated");
    expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
    expect(host.textContent).toBe("empty");
  });

  // #435: a session result may publish only if nothing newer was published
  // after its request was sent.
  describe("late results", () => {
    it("keeps a confirmed logout when a session read sent before it completes afterwards", async () => {
      const held = holdSessionRead();
      const late = auth.refreshSession();
      await act(async () => { await auth.logout(); });
      expect(auth.status).toBe("unauthenticated");
      expect(queryClient.getQueryData(["privileged"])).toBeUndefined();

      vi.mocked(setCsrfToken).mockClear();
      await act(async () => {
        held.resolve({ principal: nextPrincipal, csrfToken: "retired-csrf" });
        await late;
      });
      expect(auth.status).toBe("unauthenticated");
      expect(auth.principal).toBeNull();
      expect(setCsrfToken).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
      expect(host.textContent).toBe("empty");
    });

    it("does not let an older session read's 401 clear a newer accepted session", async () => {
      const held = holdSessionRead();
      const late = auth.refreshSession();
      await act(async () => { await auth.refreshSession(); });
      await act(async () => {
        held.reject(unauthorized());
        await late;
      });
      expect(auth.status).toBe("authenticated");
      expect(auth.principal).toEqual(nextPrincipal);
      expect(queryClient.getQueryData(["privileged"])).toBe("old-admin-settings");
    });

    it("does not let a 401 for a read sent before a sign-in clear the new session", async () => {
      const signedIn: AuthPrincipal = {
        subject: "ferrum-foundry-static",
        displayName: "Local administrator",
        role: "admin",
        authMode: "static",
      };
      const held = holdSessionRead();
      const late = auth.refreshSession();
      transport.post.mockReturnValueOnce({
        json: async () => ({ principal: signedIn, csrfToken: "new-csrf" }),
      });
      await act(async () => { await auth.login("development-token"); });
      expect(auth.principal).toEqual(signedIn);

      await act(async () => {
        held.reject(unauthorized());
        await late;
      });
      expect(auth.status).toBe("authenticated");
      expect(auth.principal).toEqual(signedIn);
      expect(vi.mocked(setCsrfToken).mock.calls.at(-1)?.[0]).toBe("new-csrf");
    });

    it("ignores the client's 401 for a request sent before the current session was accepted", async () => {
      const stale = issueRequestTicket();
      await act(async () => { await auth.refreshSession(); });
      const onUnauthorized = vi.mocked(setOnUnauthorized).mock.calls.at(-1)![0]!;
      act(() => { onUnauthorized(stale); });
      expect(auth.status).toBe("authenticated");
      expect(queryClient.getQueryData(["privileged"])).toBe("old-admin-settings");

      // A 401 for a request sent after it still signs this tab out.
      act(() => { onUnauthorized(issueRequestTicket()); });
      expect(auth.status).toBe("unauthenticated");
      expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    });

    it("does not restore superseded grants from an older session read", async () => {
      const privileged = nextPrincipal;
      const held = holdSessionRead();
      const late = auth.refreshSession();
      nextPrincipal = { ...nextPrincipal, role: "viewer", namespaces: ["tenant-a"] };
      await act(async () => { await auth.refreshSession(); });
      expect(auth.principal).toEqual(nextPrincipal);
      queryClient.setQueryData(["privileged"], "viewer-data");

      await act(async () => {
        held.resolve({ principal: privileged, csrfToken: "privileged-csrf" });
        await late;
      });
      expect(auth.principal).toEqual(nextPrincipal);
      expect(queryClient.getQueryData(["privileged"])).toBe("viewer-data");
      expect(vi.mocked(setCsrfToken).mock.calls.at(-1)?.[0]).toBe("csrf");
    });

    it.each<[string, (held: ReturnType<typeof deferred<unknown>>) => void]>([
      ["a 401", (held) => held.reject(unauthorized())],
      ["another subject's session", (held) => held.resolve({
        principal: { ...nextPrincipal, subject: "another-user" },
        csrfToken: "retired-csrf",
      })],
    ])("does not let a replaced provider publish %s over its replacement", async (_outcome, complete) => {
      const held = holdSessionRead();
      const late = auth.refreshSession();
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <AuthProvider key="replacement"><Workspace /></AuthProvider>
          </QueryClientProvider>,
        );
      });
      expect(auth.status).toBe("authenticated");
      queryClient.setQueryData(["privileged"], "replacement-data");

      vi.mocked(setCsrfToken).mockClear();
      await act(async () => {
        complete(held);
        await late;
      });
      expect(setCsrfToken).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(["privileged"])).toBe("replacement-data");
      expect(auth.status).toBe("authenticated");
      expect(auth.principal).toEqual(nextPrincipal);
    });

    it("still signs out when the current session read is refused", async () => {
      transport.get.mockImplementationOnce(() => ({
        json: async () => { throw unauthorized(); },
      }));
      await act(async () => { await auth.refreshSession(); });
      expect(auth.status).toBe("unauthenticated");
      expect(queryClient.getQueryData(["privileged"])).toBeUndefined();
    });
  });
});

// The config and session reads are independent, so boot sends both at once.
// What they publish must still not depend on which answer arrives first.
describe("boot reads", () => {
  let root: Root;
  let host: HTMLDivElement;
  let config: ReturnType<typeof deferred<unknown>>;
  let session: ReturnType<typeof deferred<unknown>>;
  const principal: AuthPrincipal = {
    subject: "boot-user",
    displayName: "Boot user",
    role: "operator",
    authMode: "trusted-proxy",
  };

  /** Run `action`, then let every promise reaction it releases settle. */
  async function flush(action: () => void) {
    await act(async () => {
      action();
      await new Promise((done) => setTimeout(done, 0));
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    config = deferred<unknown>();
    session = deferred<unknown>();
    transport.get.mockImplementation((path: string) => ({
      json: () => (path === "api/auth/config" ? config.promise : session.promise),
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider><Workspace /></AuthProvider>
        </QueryClientProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    resetGatewayMetadata();
    vi.clearAllMocks();
  });

  it("sends the session read without waiting for the config read", async () => {
    expect(transport.get.mock.calls.map(([path]) => path)).toEqual([
      "api/auth/config",
      "api/auth/session",
    ]);
    expect(auth.status).toBe("loading");

    // A session that arrives first is not published until the config has.
    await flush(() => session.resolve({ principal, csrfToken: "boot-csrf" }));
    expect(auth.status).toBe("loading");
    expect(setCsrfToken).not.toHaveBeenCalled();

    await flush(() => config.resolve({ mode: "trusted-proxy" }));
    expect(auth.status).toBe("authenticated");
    expect(auth.mode).toBe("trusted-proxy");
    expect(auth.principal).toEqual(principal);
    expect(setCsrfToken).toHaveBeenLastCalledWith("boot-csrf", undefined);
  });

  function expectConfigFailure() {
    expect(auth.status).toBe("unauthenticated");
    expect(auth.error).toBe("Unable to load the Foundry authentication configuration.");
    expect(auth.mode).toBeNull();
    expect(auth.principal).toBeNull();
    expect(setCsrfToken).not.toHaveBeenCalled();
  }

  it("discards a session that arrives before a config failure", async () => {
    await flush(() => session.resolve({ principal, csrfToken: "boot-csrf" }));
    expect(auth.status).toBe("loading");
    await flush(() => config.reject(new Error("HTTP 503")));
    expectConfigFailure();
  });

  it("shows a config failure without waiting for the session read, then discards it", async () => {
    await flush(() => config.reject(new Error("HTTP 503")));
    expectConfigFailure();
    await flush(() => session.resolve({ principal, csrfToken: "boot-csrf" }));
    expectConfigFailure();
  });

  it("does not let the client publish the boot read's 401 before the config", async () => {
    // The boot read holds the newest ticket; the client reports its BFF 401 first.
    const onUnauthorized = vi.mocked(setOnUnauthorized).mock.calls.at(-1)![0]!;
    act(() => { onUnauthorized(tickets.last); });
    expect(auth.status).toBe("loading");
    await flush(() => session.reject(unauthorized()));
    expect(auth.status).toBe("loading");
    await flush(() => config.resolve({ mode: "trusted-proxy" }));
    expect(auth.status).toBe("unauthenticated");
    expect(auth.mode).toBe("trusted-proxy");
  });

  it("reports a failed session read as a session failure once the config loads", async () => {
    await flush(() => session.reject(new Error("HTTP 502")));
    expect(auth.status).toBe("loading");
    await flush(() => config.resolve({ mode: "static" }));
    expect(auth.status).toBe("unauthenticated");
    expect(auth.mode).toBe("static");
    expect(auth.error).toBe("Unable to verify your Foundry session.");
  });

  it("signs out on a refused session read once the config loads", async () => {
    await flush(() => session.reject(unauthorized()));
    await flush(() => config.resolve({ mode: "trusted-proxy" }));
    expect(auth.status).toBe("unauthenticated");
    expect(auth.mode).toBe("trusted-proxy");
    expect(auth.error).toBeNull();
    expect(setCsrfToken).toHaveBeenLastCalledWith(null);
  });
});
