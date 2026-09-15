import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream, UpstreamCreate } from "@/api/types";
import { UpstreamForm } from "./UpstreamForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const submit = vi.fn(async (_data: UpstreamCreate) => {});

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

async function mount(address: string, serviceName: string) {
  const initialData: Upstream = {
    id: "upstream-1",
    name: "payments",
    algorithm: "round_robin",
    targets: [{ host: "backend", port: 8080, weight: 1 }],
    created_at: "2026-09-06T00:00:00Z",
    updated_at: "2026-09-06T00:00:00Z",
    service_discovery: {
      provider: "consul",
      consul: { address, service_name: serviceName, datacenter: "dc1" },
    },
  };
  await act(async () => {
    root.render(
      <UpstreamForm initialData={initialData} onSubmit={submit} isLoading={false} />,
    );
  });
  const section = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Service Discovery"),
  )!;
  await act(async () => section.click());
}

async function save() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("Consul required fields", () => {
  it.each(["", "   "])("rejects a blank address (%j) before submit", async (value) => {
    await mount(value, "payments");
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Consul address is required");
  });

  it.each(["", "   "])("rejects a blank service name (%j)", async (value) => {
    await mount("http://consul:8500", value);
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Consul service name is required");
  });

  it("submits trimmed required fields and preserves nested options", async () => {
    await mount(" http://consul:8500 ", " payments ");
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        service_discovery: expect.objectContaining({
          provider: "consul",
          consul: expect.objectContaining({
            address: "http://consul:8500",
            service_name: "payments",
            datacenter: "dc1",
          }),
        }),
      }),
    );
  });

  it("does not require Consul fields after service discovery is disabled", async () => {
    await mount("", "");
    const checkbox = Array.from(host.querySelectorAll("label")).find(
      (label) => label.textContent?.includes("Enable service discovery"),
    )!.querySelector("input")!;
    await act(async () => checkbox.click());
    await save();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0].service_discovery).toBeUndefined();
  });
});

describe("UpstreamForm collapsed validation", () => {
  it("shows Consul errors when Service Discovery stays collapsed", async () => {
    const initialData: Upstream = {
      id: "upstream-1",
      name: "payments",
      algorithm: "round_robin",
      targets: [{ host: "backend", port: 8080, weight: 1 }],
      created_at: "2026-09-06T00:00:00Z",
      updated_at: "2026-09-06T00:00:00Z",
      service_discovery: {
        provider: "consul",
        consul: { address: "", service_name: "payments", datacenter: "dc1" },
      },
    };
    await act(async () => {
      root.render(
        <UpstreamForm initialData={initialData} onSubmit={submit} isLoading={false} />,
      );
    });
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Consul address is required");
    expect(host.textContent).toContain("Fix 1 validation error above");
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("UpstreamForm duplicate Input labels", () => {
  it("gives distinct ids to both Unhealthy Threshold fields", async () => {
    const initialData: Upstream = {
      id: "upstream-1",
      name: "payments",
      algorithm: "round_robin",
      targets: [{ host: "backend", port: 8080, weight: 1 }],
      created_at: "2026-09-06T00:00:00Z",
      updated_at: "2026-09-06T00:00:00Z",
      health_checks: {
        active: {
          http_path: "/health",
          interval_seconds: 10,
          timeout_ms: 5000,
          healthy_threshold: 3,
          unhealthy_threshold: 3,
          healthy_status_codes: [200, 302],
          probe_type: "http",
          use_tls: false,
        },
        passive: {
          unhealthy_threshold: 7,
          unhealthy_status_codes: [500, 502, 503, 504],
          unhealthy_window_seconds: 30,
          healthy_after_seconds: 30,
        },
      },
    };
    await act(async () => {
      root.render(
        <UpstreamForm initialData={initialData} onSubmit={submit} isLoading={false} />,
      );
    });
    const section = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Health Checks"),
    )!;
    await act(async () => section.click());

    const labels = Array.from(host.querySelectorAll("label")).filter(
      (label) => label.textContent?.trim() === "Unhealthy Threshold",
    );
    expect(labels).toHaveLength(2);
    const inputIds = labels.map((label) => label.getAttribute("for"));
    expect(new Set(inputIds).size).toBe(2);
    for (const label of labels) {
      const forId = label.getAttribute("for");
      expect(forId).toBeTruthy();
      const input = host.querySelector<HTMLInputElement>(`#${CSS.escape(forId!)}`);
      expect(input).not.toBeNull();
      expect(label.control).toBe(input);
    }
  });
});
