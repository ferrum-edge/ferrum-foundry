import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BffReadiness } from "@/hooks/useBffHealth";
import { Header } from "./Header";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/client")>(),
  api: { get },
}));
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "default", setNamespace: vi.fn() }),
}));
vi.mock("@/hooks/useNamespaces", () => ({
  useNamespaces: () => ({ data: ["default"] }),
}));
vi.mock("@/stores/theme", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }),
}));
vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ principal: null, logout: vi.fn() }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ready: BffReadiness = {
  status: "ready",
  ready: true,
  version: "test",
  checkedAt: "2026-09-05T00:00:00Z",
  components: { bff: { status: "ok" }, gateway: { status: "ok" } },
};
const queryKey = ["bff-readiness"];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function respond(body: BffReadiness) {
  get.mockImplementation(async () => new Response(JSON.stringify(body)));
}

async function waitForLabel(label: string) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain(label);
  });
}

beforeEach(async () => {
  get.mockReset();
  respond(ready);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Header onToggleSidebar={() => {}} />
      </QueryClientProvider>,
    );
  });
  await waitForLabel("Connected");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("Header readiness and accessibility", () => {
  it("overrides cached success after a transport failure and recovers", async () => {
    get.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    await waitForLabel("Unreachable");
    expect(client.getQueryState(queryKey)?.status).toBe("error");
    expect(client.getQueryData(queryKey)).toEqual(ready);
    expect(host.textContent).not.toContain("Connected");
    expect(host.querySelector(".bg-success")).toBeNull();
    expect(host.querySelector(".bg-danger")).not.toBeNull();

    respond(ready);
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    await waitForLabel("Connected");
    expect(client.getQueryState(queryKey)?.status).toBe("success");
    expect(host.textContent).not.toContain("Unreachable");
    expect(host.querySelector(".bg-success")).not.toBeNull();
  });

  it("preserves the gateway's degraded readiness status", async () => {
    respond({ ...ready, status: "degraded", ready: false });
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    await waitForLabel("Degraded");
    expect(host.querySelector(".bg-warning")).not.toBeNull();
  });

  it("names the namespace combobox from its visible label", () => {
    const trigger = host.querySelector('[role="combobox"]');
    expect(trigger).not.toBeNull();
    const label = document.getElementById(
      trigger!.getAttribute("aria-labelledby") ?? "",
    );
    expect(label?.textContent?.trim()).toBe("Active Namespace:");
  });
});
