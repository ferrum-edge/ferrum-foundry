import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as consumers from "@/api/consumers";
import {
  DEFAULT_NAMESPACE,
  NAMESPACE_STORAGE_KEY,
  NamespaceProvider,
  useNamespace,
} from "./namespace";

// The provider only reads `principal` from the auth store; a real
// AuthProvider would need a query client and a session round-trip.
vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ principal: null }),
}));

// React requires this flag before `act()` will flush updates synchronously.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type NamespaceHandle = ReturnType<typeof useNamespace>;

/** Renders the active namespace and hands the context value to the test. */
function Probe({ onValue }: { onValue: (value: NamespaceHandle) => void }) {
  const value = useNamespace();
  useEffect(() => {
    onValue(value);
  });
  return <span data-testid="active">{value.selectedNamespace}</span>;
}

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = new URL(input, "http://localhost").toString();
    }
    super(input, init);
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  namespace: string | null;
}

/** Deliver the browser's cross-tab notification for a storage write. */
function otherTabSwitches(to: string): void {
  const from = localStorage.getItem(NAMESPACE_STORAGE_KEY);
  localStorage.setItem(NAMESPACE_STORAGE_KEY, to);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: NAMESPACE_STORAGE_KEY,
      oldValue: from,
      newValue: to,
      storageArea: localStorage,
      url: "http://localhost/",
    }),
  );
}

describe("NamespaceProvider binding", () => {
  const captured: CapturedRequest[] = [];
  let latest: NamespaceHandle | undefined;
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  async function mount(): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const created = createRoot(container);
    await act(async () => {
      created.render(
        <NamespaceProvider>
          <Probe onValue={(value) => { latest = value; }} />
        </NamespaceProvider>,
      );
    });
    host = container;
    root = created;
    return container;
  }

  function displayed(): string {
    return host?.querySelector("[data-testid=active]")?.textContent ?? "";
  }

  beforeEach(() => {
    captured.length = 0;
    latest = undefined;
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        captured.push({
          url: request.url,
          method: request.method,
          namespace: request.headers.get("x-ferrum-namespace"),
        });
        return new Response(
          JSON.stringify({ id: "alice", username: "alice" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(async () => {
    const activeRoot = root;
    const activeHost = host;
    root = null;
    host = null;
    if (activeRoot) {
      await act(async () => {
        activeRoot.unmount();
      });
    }
    activeHost?.remove();
    vi.unstubAllGlobals();
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  });

  it("keeps a write in the namespace this tab displays after another tab switches", async () => {
    // Tab A opens on tenant-a.
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    await mount();
    expect(displayed()).toBe("tenant-a");

    // Tab B switches to tenant-b; the shared key changes and tab A is told.
    await act(async () => {
      otherTabSwitches("tenant-b");
    });
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("tenant-b");

    // Tab A still displays tenant-a and its next write goes there — the
    // header comes from the scope the provider handed out, not from storage.
    expect(displayed()).toBe("tenant-a");
    await consumers.create(latest!.scope, { username: "alice" });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].namespace).toBe(displayed());
  });

  it("drives the header from React state when storage is unavailable", async () => {
    const denied = () => {
      throw new Error("SecurityError: storage is disabled");
    };
    vi.stubGlobal("localStorage", {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    });

    await mount();
    // No persisted preference can be read, so the display and the binding
    // both start from the same default.
    expect(displayed()).toBe(DEFAULT_NAMESPACE);
    expect(latest!.scope.namespace).toBe(DEFAULT_NAMESPACE);

    await act(async () => {
      latest!.setNamespace("tenant-c");
    });
    expect(displayed()).toBe("tenant-c");

    // The old client fell back to "ferrum" here because it could not read
    // storage, silently diverging from the displayed namespace.
    await consumers.create(latest!.scope, { username: "alice" });
    expect(captured[0].namespace).toBe("tenant-c");
  });

  it("binds an operation to the scope captured when it started", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    await mount();
    const startedUnderA = latest!.scope;

    await act(async () => {
      latest!.setNamespace("tenant-b");
    });
    expect(displayed()).toBe("tenant-b");

    // An operation that began before the switch keeps its binding; a new one
    // picks up the new selection.
    await consumers.create(startedUnderA, { username: "alice" });
    await consumers.create(latest!.scope, { username: "bob" });
    expect(captured.map((request) => request.namespace)).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
  });

  it("reads storage once as a preference and writes the user's switch back", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    await mount();
    expect(displayed()).toBe("tenant-a");

    await act(async () => {
      latest!.setNamespace("tenant-b");
    });
    expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("tenant-b");

    // A cross-tab change is not observed: it takes effect only when a tab
    // next mounts the provider.
    await act(async () => {
      otherTabSwitches("tenant-c");
    });
    expect(displayed()).toBe("tenant-b");
    expect(latest!.scope.namespace).toBe("tenant-b");
  });

  it("falls back to the default when the persisted preference is blank", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "");
    await mount();
    expect(displayed()).toBe(DEFAULT_NAMESPACE);
  });
});
