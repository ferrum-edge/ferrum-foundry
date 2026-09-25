import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream, UpstreamCreate } from "@/api/types";
import { blurField, clearText, inputByLabel, inputByLabelOrNull, typeText } from "@/test/fields";
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

async function mountPlain(overrides: Partial<Upstream> = {}) {
  const initialData: Upstream = {
    id: "upstream-2",
    name: "orders",
    algorithm: "round_robin",
    targets: [{ host: "backend", port: 8080, weight: 1 }],
    created_at: "2026-09-06T00:00:00Z",
    updated_at: "2026-09-06T00:00:00Z",
    ...overrides,
  };
  await act(async () => {
    root.render(
      <UpstreamForm initialData={initialData} onSubmit={submit} isLoading={false} />,
    );
  });
}

async function toggleSection(title: string) {
  const section = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(title),
  )!;
  await act(async () => section.click());
}

async function check(label: string) {
  const box = Array.from(host.querySelectorAll("label")).find(
    (entry) => entry.textContent?.trim() === label,
  )!.querySelector("input")!;
  await act(async () => box.click());
}

function submitted(): UpstreamCreate {
  expect(submit).toHaveBeenCalledOnce();
  return submit.mock.calls[0]![0];
}

describe("UpstreamForm status-code drafts (#400)", () => {
  it("accepts comma-separated codes typed one character at a time", async () => {
    await mountPlain();
    await toggleSection("Health Checks");
    await check("Enable active health checks");
    await check("Enable passive health checks");

    const healthy = inputByLabel(host, "Healthy Status Codes");
    await clearText(healthy);
    await typeText(healthy, "200, 302");
    expect(healthy.value).toBe("200, 302");
    await blurField(healthy);

    const unhealthy = inputByLabel(host, "Unhealthy Status Codes");
    await clearText(unhealthy);
    await typeText(unhealthy, "500, 502, 503");
    expect(unhealthy.value).toBe("500, 502, 503");
    await blurField(unhealthy);

    expect(host.querySelector('[aria-invalid="true"]')).toBeNull();
    await save();
    const health = submitted().health_checks!;
    expect(health.active?.healthy_status_codes).toEqual([200, 302]);
    expect(health.passive?.unhealthy_status_codes).toEqual([500, 502, 503]);
  });

  it.each(["200x", "99", "600"])(
    "keeps the invalid token %j visible, reports it accessibly, and blocks submit",
    async (token) => {
      await mountPlain();
      await toggleSection("Health Checks");
      await check("Enable active health checks");

      const healthy = inputByLabel(host, "Healthy Status Codes");
      await clearText(healthy);
      await typeText(healthy, `200, ${token}`);
      await blurField(healthy);
      expect(healthy.value).toBe(`200, ${token}`);
      expect(healthy.getAttribute("aria-invalid")).toBe("true");
      const description = document.getElementById(healthy.getAttribute("aria-describedby")!);
      expect(description?.textContent).toContain(`"${token}" is not an HTTP status code (100-599)`);

      await save();
      expect(submit).not.toHaveBeenCalled();
      expect(healthy.value).toBe(`200, ${token}`);
      expect(host.textContent).toContain("Fix 1 validation error above");

      await clearText(healthy);
      await typeText(healthy, "204");
      await blurField(healthy);
      expect(healthy.getAttribute("aria-invalid")).toBeNull();
      await save();
      expect(submitted().health_checks?.active?.healthy_status_codes).toEqual([204]);
    },
  );

  it("sends untouched code lists exactly as loaded, including an absent one", async () => {
    await mountPlain({
      health_checks: {
        active: { http_path: "/ready", interval_seconds: 5 },
        passive: { unhealthy_status_codes: [500] },
      },
    });
    await save();
    const health = submitted().health_checks!;
    expect(health.active).toEqual({ http_path: "/ready", interval_seconds: 5 });
    expect(health.active).not.toHaveProperty("healthy_status_codes");
    expect(health.passive).toEqual({ unhealthy_status_codes: [500] });
  });
});

describe("UpstreamForm probe targets (Ferrum Edge v0.9.7)", () => {
  it("refuses an HTTP path that does not start with / before submitting", async () => {
    await mountPlain();
    await toggleSection("Health Checks");
    await check("Enable active health checks");

    const path = inputByLabel(host, "HTTP Path");
    await clearText(path);
    await typeText(path, "@169.254.169.254/");
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(path.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("HTTP path must start with /");

    await clearText(path);
    await typeText(path, "/ready");
    await save();
    expect(submitted().health_checks?.active?.http_path).toBe("/ready");
  });

  it.each(["abc", "0g", "0 00"])(
    "refuses the UDP payload %j, which is not whole hex bytes",
    async (payload) => {
      await mountPlain({
        health_checks: {
          active: { probe_type: "udp", interval_seconds: 5, udp_probe_payload: "00" },
        },
      });
      await toggleSection("Health Checks");

      const field = inputByLabel(host, "UDP Probe Payload");
      await clearText(field);
      await typeText(field, payload);
      await save();
      expect(submit).not.toHaveBeenCalled();
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(host.textContent).toContain("UDP probe payload must be hex");

      await clearText(field);
      await typeText(field, "00ff");
      await save();
      expect(submitted().health_checks?.active?.udp_probe_payload).toBe("00ff");
    },
  );

  it("accepts an empty UDP payload, which Edge answers with a single zero byte", async () => {
    await mountPlain({
      health_checks: {
        active: { probe_type: "udp", interval_seconds: 5, udp_probe_payload: "00" },
      },
    });
    await toggleSection("Health Checks");
    await clearText(inputByLabel(host, "UDP Probe Payload"));
    await save();
    expect(submitted().health_checks?.active?.udp_probe_payload).toBeUndefined();
  });
});

describe("UpstreamForm numeric drafts (#402)", () => {
  it("clears and retypes a health-check interval without inserting 0", async () => {
    await mountPlain();
    await toggleSection("Health Checks");
    await check("Enable active health checks");

    const interval = inputByLabel(host, "Interval (seconds)");
    await clearText(interval);
    expect(interval.value).toBe("");
    await typeText(interval, "15");
    expect(interval.value).toBe("15");
    await save();
    expect(submitted().health_checks?.active).toMatchObject({
      interval_seconds: 15,
      timeout_ms: 5000,
      healthy_status_codes: [200, 302],
    });
  });

  it("reopens a collapsed Health Checks section for an empty required field", async () => {
    await mountPlain();
    await toggleSection("Health Checks");
    await check("Enable passive health checks");
    await clearText(inputByLabel(host, "Unhealthy Window (seconds)"));
    await toggleSection("Health Checks");
    expect(inputByLabelOrNull(host, "Unhealthy Window (seconds)")).toBeNull();

    await save();
    expect(submit).not.toHaveBeenCalled();
    const windowField = inputByLabel(host, "Unhealthy Window (seconds)");
    expect(windowField.value).toBe("");
    expect(windowField.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Unhealthy window is required");

    await typeText(windowField, "45");
    await save();
    expect(submitted().health_checks?.passive?.unhealthy_window_seconds).toBe(45);
  });

  it("requires a service-discovery poll interval instead of sending 0", async () => {
    await mountPlain({
      targets: [],
      service_discovery: {
        provider: "dns_sd",
        dns_sd: { service_name: "_orders._tcp.example", poll_interval_seconds: 20 },
      },
    });
    await toggleSection("Service Discovery");
    const poll = inputByLabel(host, "Poll Interval (seconds)");
    await clearText(poll);
    expect(poll.value).toBe("");
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Poll interval is required");

    await typeText(poll, "60");
    await save();
    expect(submitted().service_discovery?.dns_sd?.poll_interval_seconds).toBe(60);
  });
});

describe("UpstreamForm Kubernetes discovery", () => {
  it("carries provider keys the form does not model through a save", async () => {
    await mountPlain({
      targets: [],
      service_discovery: {
        provider: "consul",
        consul: {
          address: "http://consul.internal:8500",
          service_name: "api",
          a_newer_gateway_field: { nested: true },
        } as never,
      },
    });
    await save();
    expect(submitted().service_discovery?.consul).toMatchObject({
      address: "http://consul.internal:8500",
      service_name: "api",
      a_newer_gateway_field: { nested: true },
    });
  });

  it("keeps a loaded address_type on an unrelated save", async () => {
    await mountPlain({
      targets: [],
      service_discovery: {
        provider: "kubernetes",
        kubernetes: {
          service_name: "api",
          namespace: "prod",
          address_type: "IPv6",
          poll_interval_seconds: 30,
        },
      },
    });
    await save();
    expect(submitted().service_discovery?.kubernetes).toEqual({
      service_name: "api",
      namespace: "prod",
      address_type: "IPv6",
      poll_interval_seconds: 30,
    });
  });
});
