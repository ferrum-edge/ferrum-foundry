import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HashOnCookieConfig, ServiceDiscoveryConfig, Upstream, UpstreamCreate } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { click, createHarness, fill, selectOption } from "@/test/__tests__/harness";
import { UpstreamForm } from "./UpstreamForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
let ui: ReturnType<typeof createHarness>;
const submit = vi.fn<(data: UpstreamCreate) => Promise<void>>();
const initial: Upstream = {
  id: "orders", name: "Orders", algorithm: "round_robin",
  targets: [{ host: "backend", port: 8080, weight: 1, path: "/v1", tags: { version: "v1" } }],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

beforeEach(() => {
  ui = createHarness();
  submit.mockReset();
  submit.mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  await ui.dispose();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(data?: Upstream) {
  await ui.render(<UpstreamForm initialData={data} onSubmit={submit} isLoading={false} />);
}

async function save() {
  await act(async () => {
    ui.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function section(title: string) {
  const button = [...ui.host.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.includes(title))!;
  await act(async () => button.click());
}

async function check(label: string) {
  const control = [...ui.host.querySelectorAll("label")]
    .find((entry) => entry.textContent?.trim() === label)!.querySelector<HTMLInputElement>("input")!;
  await act(async () => control.click());
}

describe("TargetForm inside the upstream payload editor", () => {
  it("keeps target add/edit/remove local until the upstream is explicitly submitted", async () => {
    await mount();
    await save();
    expect(ui.host.textContent).toContain("At least one target is required");
    await click("Add Target", ui.host);
    await fill(inputByLabel(ui.host, "Host"), " orders.internal ");
    await click("Add Target", ui.host);
    expect(submit).not.toHaveBeenCalled();
    expect(ui.host.textContent).toContain("orders.internal:80");
    await fill(inputByLabel(ui.host, "Name"), " Orders ");
    const actions = () => [...ui.host.querySelectorAll<HTMLButtonElement>("button")]
      .filter((entry) => entry.textContent?.trim() === "");
    await act(async () => actions()[0].click());
    await fill(inputByLabel(ui.host, "Port"), "8080");
    await click("Update Target", ui.host);
    expect(submit).not.toHaveBeenCalled();
    await save();
    const expected: UpstreamCreate = {
      name: "Orders", algorithm: "round_robin", backend_tls_verify_server_cert: true,
      targets: [{ host: "orders.internal", port: 8080, weight: 1, path: null, locality: null, tags: {} }],
    };
    expect(submit).toHaveBeenCalledExactlyOnceWith(expected);
    await act(async () => actions()[1].click());
    await save();
    expect(submit).toHaveBeenCalledOnce();
    expect(ui.host.textContent).toContain("At least one target is required");
  });

  it("preserves target tags while configuring cookie hashing and backend TLS", async () => {
    await mount(initial);
    await selectOption("Algorithm", "Consistent Hashing");
    await save();
    expect(ui.host.textContent).toContain("Hash key is required");
    expect(submit).not.toHaveBeenCalled();
    await fill(inputByLabel(ui.host, "Hash On"), "cookie:route");
    await section("Hash Cookie Config");
    for (const [label, value] of [["Path", "/orders"], ["TTL (seconds)", "120"], ["Domain", ".example.test"]]) {
      await fill(inputByLabel(ui.host, label), value);
    }
    await check("HTTP Only");
    await check("Secure");
    await check("Session Cookie");
    await selectOption("SameSite", "Strict");
    await section("Backend TLS");
    for (const [label, value] of [
      ["Client Cert Path (mTLS)", "managed://certificates/client"], ["Client Key Path (mTLS)", "managed://certificates/client"],
      ["Server CA Cert Path", "system://"], ["SNI Override", "orders.example.test"], ["SAN Allow List", " orders.example.test, , api.example.test "],
    ]) await fill(inputByLabel(ui.host, label), value);
    await check("Verify backend server certificate");
    await save();
    expect(submit.mock.calls[0][0]).toEqual({
      name: "Orders", algorithm: "consistent_hashing", targets: initial.targets,
      hash_on: "cookie:route", hash_on_cookie_config: {
        path: "/orders", ttl_seconds: 120, domain: ".example.test", http_only: false,
        secure: true, session_cookie: true, same_site: "Strict",
      },
      backend_tls_client_cert_path: "managed://certificates/client",
      backend_tls_client_key_path: "managed://certificates/client", backend_tls_verify_server_cert: false,
      backend_tls_server_ca_cert_path: "system://", backend_tls_sni: "orders.example.test",
      backend_tls_san_allow_list: ["orders.example.test", "api.example.test"],
    } satisfies UpstreamCreate);
  });

  it("submits active and passive target health policy by presence and omits disabled checks", async () => {
    await mount(initial);
    await section("Health Checks");
    await check("Enable active health checks");
    for (const [label, value] of [["Interval (seconds)", "15"], ["Timeout (ms)", "2000"],
      ["Healthy Threshold", "2"], ["Unhealthy Threshold", "4"], ["HTTP Path", "/ready"],
      ["Healthy Status Codes", "200, 204"]]) await fill(inputByLabel(ui.host, label), value);
    await check("Use HTTPS for health probes");
    await check("Enable passive health checks");
    for (const [label, value] of [["Unhealthy Status Codes", "500, 503"],
      ["Unhealthy Window (seconds)", "45"], ["Auto-recovery After (seconds)", "90"],
      ["Max Ejection Percent", "25"]]) await fill(inputByLabel(ui.host, label), value);
    const thresholds = [...ui.host.querySelectorAll("label")].filter((label) => label.textContent === "Unhealthy Threshold");
    await fill(thresholds[1].control as HTMLInputElement, "6");
    await save();
    expect(submit.mock.calls[0][0].health_checks).toEqual({
      active: { probe_type: "http", interval_seconds: 15, timeout_ms: 2000, healthy_threshold: 2,
        unhealthy_threshold: 4, http_path: "/ready", healthy_status_codes: [200, 204], use_tls: true },
      passive: { unhealthy_status_codes: [500, 503], unhealthy_threshold: 6,
        unhealthy_window_seconds: 45, healthy_after_seconds: 90, max_ejection_percent: 25 },
    });
    await selectOption("Probe Type", "UDP");
    await fill(inputByLabel(ui.host, "UDP Probe Payload"), "aabb");
    await save();
    expect(submit.mock.calls[1][0].health_checks?.active).toMatchObject({ probe_type: "udp", udp_probe_payload: "aabb" });
    await selectOption("Probe Type", "gRPC (grpc.health.v1)");
    await fill(inputByLabel(ui.host, "gRPC Service Name"), "orders.Health");
    await save();
    expect(submit.mock.calls[2][0].health_checks?.active).toMatchObject({ probe_type: "grpc", grpc_service_name: "orders.Health" });
    await check("Enable active health checks");
    await check("Enable passive health checks");
    await save();
    expect(submit.mock.calls[3][0]).not.toHaveProperty("health_checks");
  });

  it("edits subset labels and retains policy when updating a target-bearing upstream", async () => {
    await mount({ ...initial, subsets: [{ name: "old", labels: { version: "v1" }, traffic_policy: { hash_on: "ip" } }] });
    await section("Subsets");
    const group = ui.host.querySelector<HTMLElement>('[role="group"][aria-label="Subset old"]')!;
    await fill(inputByLabel(group, "Subset Name"), " canary ");
    await fill(group.querySelector<HTMLInputElement>('input[aria-label="Subset canary label 1 value"]')!, "v2");
    await click("Add label to subset canary", group);
    await fill(group.querySelector<HTMLInputElement>('input[aria-label="Subset canary label 2 key"]')!, "tier");
    await fill(group.querySelector<HTMLInputElement>('input[aria-label="Subset canary label 2 value"]')!, "canary");
    await fill(inputByLabel(ui.host, "Subset Hash Key"), " header:x-tenant ");
    await selectOption("Subset Algorithm", "Consistent Hashing");
    await click("Add Subset", ui.host);
    await save();
    expect(submit.mock.calls[0][0].subsets).toEqual([{
      name: "canary", labels: { version: "v2", tier: "canary" },
      traffic_policy: { load_balancer_algorithm: "consistent_hashing", hash_on: "header:x-tenant" },
    }]);
    expect(submit.mock.calls[0][0].targets).toEqual(initial.targets);
  });

  it("submits provider-specific discovery for upstreams whose targets are discovered", async () => {
    await mount();
    await section("Service Discovery");
    await check("Enable service discovery");
    await fill(inputByLabel(ui.host, "Service Name"), "orders");
    const cases: Array<{
      label: string;
      fields: Record<string, string>;
      expected: ServiceDiscoveryConfig;
    }> = [
      { label: "DNS Service Discovery", fields: {}, expected: {
        provider: "dns_sd", dns_sd: { service_name: "orders", poll_interval_seconds: 15 },
      } },
      { label: "Kubernetes", fields: { Namespace: "api", "Port Name": "http", "Label Selector": "app=orders" },
        expected: { provider: "kubernetes", kubernetes: {
          service_name: "orders", namespace: "api", port_name: "http", label_selector: "app=orders", poll_interval_seconds: 15,
        } } },
      { label: "Consul", fields: { Address: "https://consul.example.test", Datacenter: "dc1", Tag: "canary" },
        expected: { provider: "consul", consul: {
          address: "https://consul.example.test", service_name: "orders", datacenter: "dc1",
          tag: "canary", healthy_only: false, poll_interval_seconds: 15,
        } } },
      { label: "Ferrum Mesh", fields: { "Mesh Namespace": "api", "Service Port": "8080" },
        expected: { provider: "mesh", mesh: {
          service_name: "orders", namespace: "api", port: 8080, topology: "sidecar", poll_interval_seconds: 15,
        } } },
    ];
    for (const [index, entry] of cases.entries()) {
      await selectOption("Provider", entry.label);
      for (const [label, value] of Object.entries(entry.fields)) await fill(inputByLabel(ui.host, label), value);
      await fill(inputByLabel(ui.host, "Poll Interval (seconds)"), "15");
      await fill(inputByLabel(ui.host, "Default Weight"), "4");
      await fill(inputByLabel(ui.host, "Maximum Stale Age (seconds)"), "120");
      await selectOption("Stale Endpoint Policy", "Withdraw stale endpoints");
      if (entry.label === "Consul") await check("Healthy Only");
      if (entry.label === "Ferrum Mesh") await selectOption("Topology", "Sidecar (mTLS :15006)");
      await save();
      expect(submit.mock.calls[index][0].targets).toEqual([]);
      expect(submit.mock.calls[index][0].service_discovery).toEqual({
        ...entry.expected, default_weight: 4, max_stale_seconds: 120, stale_policy: "withdraw",
      });
    }
  });

  it("keeps an open target draft on its own target when another row is removed (#448)", async () => {
    const hosts = ["a", "b", "c", "d"];
    await mount({ ...initial, targets: hosts.map((host) => ({ host, port: 80, weight: 1 })) });
    await click("Edit target b:80", ui.host);
    await fill(inputByLabel(ui.host, "Host"), "b-draft");
    // A row before the edited one, then a row after it.
    await click("Remove target a:80", ui.host);
    expect(inputByLabel(ui.host, "Host").value).toBe("b-draft");
    await click("Remove target d:80", ui.host);
    expect(inputByLabel(ui.host, "Host").value).toBe("b-draft");
    expect(ui.host.textContent).toContain("c:80");
    await click("Update Target", ui.host);
    await save();
    expect(submit.mock.calls[0][0].targets).toEqual([
      { host: "b-draft", port: 80, weight: 1, path: null, locality: null, tags: {} },
      { host: "c", port: 80, weight: 1 },
    ]);
  });

  it("names each target row action after its target and hides the icons (#455)", async () => {
    await mount({ ...initial, targets: [
      { host: "backend", port: 8080, weight: 1 }, { host: "backup", port: 9090, weight: 1 },
    ] });
    for (const name of ["Edit target backend:8080", "Remove target backend:8080",
      "Edit target backup:9090", "Remove target backup:9090"]) {
      const action = ui.host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
      expect(action, name).not.toBeNull();
      expect(action!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    await click("Remove target backend:8080", ui.host);
    expect(ui.host.textContent).not.toContain("backend:8080");
    expect(ui.host.textContent).toContain("backup:9090");
  });

  describe("sticky-cookie SameSite through an unrelated save (#449)", () => {
    type SameSite = Pick<HashOnCookieConfig, "same_site">;
    const cookieUpstream = (sameSite: SameSite): Upstream => ({
      ...initial, algorithm: "consistent_hashing", hash_on: "cookie:route",
      hash_on_cookie_config: {
        path: "/", ttl_seconds: 3600, http_only: true, secure: false, session_cookie: false, ...sameSite,
      },
    });

    const stored: [string, SameSite][] = [
      ["null", { same_site: null }],
      ["Strict", { same_site: "Strict" }],
      ["Lax", { same_site: "Lax" }],
      ["None", { same_site: "None" }],
    ];

    it.each(stored)("keeps a stored %s SameSite", async (_label, sameSite) => {
      await mount(cookieUpstream(sameSite));
      await fill(inputByLabel(ui.host, "Name"), "Renamed");
      await save();
      expect(submit.mock.calls[0][0].name).toBe("Renamed");
      expect(submit.mock.calls[0][0].hash_on_cookie_config).toHaveProperty("same_site", sameSite.same_site);
    });

    it("keeps an omitted SameSite omitted", async () => {
      await mount(cookieUpstream({}));
      await fill(inputByLabel(ui.host, "Name"), "Renamed");
      await save();
      expect(submit.mock.calls[0][0].hash_on_cookie_config).not.toHaveProperty("same_site");
    });

    it("lets the operator clear a stored SameSite", async () => {
      await mount(cookieUpstream({ same_site: "Strict" }));
      await section("Hash Cookie Config");
      await selectOption("SameSite", "Not set");
      await save();
      expect(submit.mock.calls[0][0].hash_on_cookie_config).not.toHaveProperty("same_site");
    });

    it("defaults only a cookie config the form creates to Lax", async () => {
      await mount({ ...initial, algorithm: "consistent_hashing", hash_on: "cookie:route" });
      await save();
      expect(submit.mock.calls[0][0].hash_on_cookie_config).toHaveProperty("same_site", "Lax");
    });
  });
});
