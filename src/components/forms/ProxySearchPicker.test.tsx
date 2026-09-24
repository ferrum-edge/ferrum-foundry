import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proxy } from "@/api/types";
import { ProxySearchPicker } from "./ProxySearchPicker";

const catalog: Proxy[] = [
  { id: "orders", name: "Orders", listen_path: "/orders", backend_host: "orders.internal", backend_port: 8080 },
  { id: "orders-v2", name: "Orders v2", listen_path: "/orders/v2", backend_host: "orders.internal", backend_port: 8080 },
  { id: "mqtt", name: "MQTT Broker", listen_path: null, backend_scheme: "tcps", backend_host: "mqtt.internal", backend_port: 8883 },
] as unknown as Proxy[];

vi.mock("@/hooks/useProxies", () => ({
  describeProxy: (proxy: Proxy) => proxy.name ?? proxy.id,
  useProxyCatalog: () => ({
    proxies: catalog,
    total: catalog.length,
    complete: true,
    expanding: false,
    query: {
      data: { data: catalog }, isError: false, isLoading: false, isFetching: false,
      dataUpdatedAt: 1, error: null, refetch: async () => undefined,
    },
  }),
  useProxyReferences: () => ({ names: new Map(), missing: new Set(), unresolved: new Set() }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const submitted = vi.fn();
let selection: string[];

function Harness() {
  const [value, setValue] = useState<string[]>([]);
  selection = value;
  return (
    <form onSubmit={(event) => { event.preventDefault(); submitted(); }}>
      <ProxySearchPicker label="Proxies" mode="multi" value={value} onChange={setValue} />
    </form>
  );
}

beforeEach(async () => {
  submitted.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function search(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input[aria-label="Proxies"]')!;
}

async function type(value: string) {
  await act(async () => {
    const field = search();
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    search().dispatchEvent(event);
    // What the browser does for an unhandled Enter in a form field.
    if (key === "Enter" && !event.defaultPrevented) search().form!.requestSubmit();
  });
}

describe("ProxySearchPicker", () => {
  it("is labelled for assistive technology", () => {
    expect(search()).not.toBeNull();
  });

  it("picks the first match on Enter instead of submitting the enclosing form", async () => {
    await type("ord");
    await press("Enter");
    expect(submitted).not.toHaveBeenCalled();
    expect(selection).toEqual(["orders"]);
    // Enter again adds the next unselected match; it never toggles one off.
    await press("Enter");
    expect(selection).toEqual(["orders", "orders-v2"]);
    await press("Enter");
    expect(selection).toEqual(["orders", "orders-v2"]);
  });

  it("does not render a null listen path for a stream proxy", async () => {
    await type("mqtt");
    expect(host.textContent).toContain("MQTT Broker");
    expect(host.textContent).not.toContain("null");
  });
});
