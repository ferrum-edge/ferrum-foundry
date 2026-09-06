import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useState, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY, useNamespace } from "@/stores/namespace";
import ConsumerNewPage from "./consumers/new";
import ProxyNewPage from "./proxies/new";
import UpstreamNewPage from "./upstreams/new";
import PluginNewPage from "./plugins/new";

interface DraftProps {
  onSubmit: (data: { name: string }, proxyIds?: string[]) => Promise<void>;
  defaults?: { proxyId?: string };
}

let latestSubmit: DraftProps["onSubmit"];
const writes: { namespace: string; data: unknown }[] = [];
const toast = vi.fn();
const navigate = vi.fn();

// Keep real route/session behavior; a small stateful form exposes remounting
// and retained callbacks without coupling these tests to every form schema.
function DraftForm({ onSubmit, defaults }: DraftProps) {
  const [name, setName] = useState("");
  const [proxy, setProxy] = useState(defaults?.proxyId ?? "");
  useEffect(() => { latestSubmit = onSubmit; });
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void onSubmit({ name }, proxy ? [proxy] : []);
    }}>
      <input aria-label="Draft name" value={name} onChange={(event) => setName(event.target.value)} />
      <input aria-label="Draft proxy" value={proxy} onChange={(event) => setProxy(event.target.value)} />
      <button type="submit">Save</button>
    </form>
  );
}

function useScopedMutation() {
  const { scope } = useNamespace();
  return {
    isPending: false,
    error: null,
    mutateAsync: async (data: unknown) => {
      writes.push({ namespace: scope.namespace, data });
      return { id: "created" };
    },
  };
}

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => ({ proxyId: "tenant-a-proxy" }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/forms/ConsumerForm", () => ({ ConsumerForm: DraftForm }));
vi.mock("@/components/forms/ProxyForm", () => ({ ProxyForm: DraftForm }));
vi.mock("@/components/forms/UpstreamForm", () => ({ UpstreamForm: DraftForm }));
vi.mock("@/components/forms/PluginConfigForm", () => ({ PluginConfigForm: DraftForm }));
vi.mock("@/components/forms/PluginMembershipRecovery", () => ({ PluginMembershipRecovery: () => null }));
vi.mock("@/hooks/useConsumers", () => ({ useCreateConsumer: useScopedMutation }));
vi.mock("@/hooks/useProxies", () => ({ useCreateProxy: useScopedMutation }));
vi.mock("@/hooks/useUpstreams", () => ({ useCreateUpstream: useScopedMutation }));
vi.mock("@/hooks/usePlugins", () => ({
  useCreatePluginWithMembership: useScopedMutation,
  useAvailablePlugins: () => ({ data: [], isLoading: false }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let namespace: ReturnType<typeof useNamespace>;
function NamespaceProbe() {
  const value = useNamespace();
  useEffect(() => { namespace = value; });
  return null;
}

const cases: [string, ComponentType][] = [
  ["consumer", ConsumerNewPage],
  ["proxy", ProxyNewPage],
  ["upstream", UpstreamNewPage],
  ["plugin", PluginNewPage],
];

describe.each(cases)("%s create editor namespace identity", (_kind, Page) => {
  let host: HTMLDivElement;
  let root: Root;

  async function render() {
    await act(async () => {
      root.render(<NamespaceProvider><NamespaceProbe /><Page /></NamespaceProvider>);
    });
  }

  function input(label: string) {
    return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  }

  async function type(label: string, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(label), value);
      input(label).dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(async () => {
    writes.length = 0;
    toast.mockClear();
    navigate.mockClear();
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await render();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  });

  it("discards drafts and plugin membership on switches while preserving same-tenant edits", async () => {
    await type("Draft name", "tenant-a-draft");
    await type("Draft proxy", "tenant-a-member");
    await render();
    expect(input("Draft name").value).toBe("tenant-a-draft");
    expect(input("Draft proxy").value).toBe("tenant-a-member");

    await act(async () => { namespace.setNamespace("tenant-b"); });
    expect(input("Draft name").value).toBe("");
    expect(input("Draft proxy").value).toBe("");

    await type("Draft name", "tenant-b-draft");
    await act(async () => { host.querySelector("form")!.requestSubmit(); });
    expect(writes).toEqual([{
      namespace: "tenant-b",
      data: _kind === "plugin"
        ? { data: { name: "tenant-b-draft" }, proxyIds: [] }
        : { name: "tenant-b-draft" },
    }]);

    await act(async () => { namespace.setNamespace("tenant-a"); });
    expect(input("Draft name").value).toBe("");
    expect(input("Draft proxy").value).toBe(_kind === "plugin" ? "tenant-a-proxy" : "");
  });

  it("refuses a retained submit callback after a namespace switch", async () => {
    const submitUnderA = latestSubmit;
    await act(async () => { namespace.setNamespace("tenant-b"); });
    await act(async () => { await submitUnderA({ name: "tenant-a-draft" }, ["tenant-a-member"]); });
    expect(writes).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("warning", expect.stringContaining("Discarded"));
  });
});
