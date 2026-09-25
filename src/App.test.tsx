import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { router } from "./router";
import { setCsrfToken } from "@/api/client";
import { resetGatewayMetadata } from "@/api/gatewayMetadata";
import { GATEWAY_TARGET_HEADER, resetGatewayTarget } from "@/api/gatewayTarget";
import { inputByLabel } from "@/test/fields";
import { click, createHarness, fill, page, selectOption, settle, stubFetch } from "@/test/__tests__/harness";
import { meshResponses } from "@/test/__tests__/meshFixtures";

let ui: ReturnType<typeof createHarness>;
let requests: Request[];
let clients: Set<QueryClient>;
const settings = {
  authMode: "static", adminUrl: "https://gateway.example.test", jwtIssuer: "ferrum-edge",
  jwtTtl: 900, jwtRole: "admin", tlsCaConfigured: false, tlsVerify: true,
  connectTimeout: 5000, readTimeout: 60000, writeTimeout: 60000, runtimeSettingsEnabled: true,
};

beforeEach(() => {
  clients = new Set();
  const mount = QueryClient.prototype.mount;
  vi.spyOn(QueryClient.prototype, "mount").mockImplementation(function (this: QueryClient) {
    clients.add(this);
    return mount.call(this);
  });
  ui = createHarness();
  requests = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/config") return Response.json({ mode: "static" });
    if (path === "/api/auth/session") return Response.json({
      principal: { subject: "operator", displayName: "Operator", role: "admin", namespaces: ["tenant-a"], authMode: "static" },
      csrfToken: "app-fixture-csrf",
    });
    if (path === "/api/auth/logout") return Response.json({});
    if (path === "/api/health/ready") return Response.json({
      status: "ready", ready: true, version: "test", checkedAt: "2026-09-01T00:00:00Z",
      components: { bff: { status: "ok" }, gateway: { status: "ok" } },
    });
    if (path === "/api/settings") {
      return Response.json(request.method === "PUT" ? { ...settings, ...await request.clone().json() } : settings);
    }
    if (path === "/api/settings/status") return Response.json({ reachable: true, status: 200, body: { ready: true } });
    if (path === "/api/proxy/namespaces") return Response.json(page(["tenant-a"]));
    const gatewayPath = path.replace("/api/proxy/", "");
    // The capability provider reads one authenticated health snapshot for the
    // whole workspace; a writable database-mode gateway keeps every surface on.
    if (gatewayPath === "health") {
      return Response.json({ status: "ok", ready: true, mode: "database", admin_writes_enabled: true });
    }
    if (gatewayPath in meshResponses) return Response.json(meshResponses[gatewayPath]);
    if (["admin/tls/inventory", "proxies", "consumers", "upstreams", "plugins/config"].includes(gatewayPath)) {
      return Response.json(page([]));
    }
    if (gatewayPath === "api-specs") return Response.json({ items: [], offset: 0, limit: 250, total: 0, next_offset: null });
    throw new Error(`Unexpected application request: ${request.method} ${path}`);
  });
  router.update({ history: createMemoryHistory({ initialEntries: ["/tls"] }) });
});

afterEach(async () => {
  await ui.dispose();
  for (const client of clients) client.clear();
  setCsrfToken(null);
  resetGatewayMetadata();
  resetGatewayTarget();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("loads an authenticated deep link, navigates the shell, saves settings, and signs out", async () => {
  await ui.render(<App />);
  await settle(() => expect(ui.host.querySelector("main")?.textContent).toContain("No TLS material found"));
  expect(ui.host.querySelector("h1")?.textContent).toBe("TLS Management");
  expect(ui.host.querySelectorAll("aside")).toHaveLength(1);
  await click("Toggle sidebar");
  expect(ui.host.querySelectorAll("aside")).toHaveLength(2);
  const meshLink = ui.host.querySelectorAll("aside")[1].querySelector<HTMLAnchorElement>('a[href="/mesh"]')!;
  await act(async () => meshLink.click());
  await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Mesh"));
  expect(ui.host.querySelectorAll("aside")).toHaveLength(1);
  await click("Switch to light theme");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("ferrum:theme")).toBe("light");
  await click("Switch to dark theme");
  expect(document.documentElement.dataset.theme).toBe("dark");

  await act(async () => { await router.navigate({ to: "/settings" }); });
  await settle(() => expect(ui.host.textContent).toContain("Save Settings"));
  expect(ui.host.textContent).toContain("Backup & Restore");
  await fill(inputByLabel(ui.host, "JWT Issuer"), "updated-from-ui");
  await click("Save Settings");
  await settle(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
  const save = requests.find((request) => request.method === "PUT")!;
  expect(save.headers.get("X-CSRF-Token")).toBe("app-fixture-csrf");
  expect(await save.json()).toMatchObject({ jwtIssuer: "updated-from-ui", adminUrl: settings.adminUrl });
  await click("Test Connection");
  await settle(() => expect(ui.host.textContent).toContain("Connected (HTTP 200)"));
  await selectOption("Default Refresh Interval", "Manual");
  expect(localStorage.getItem("ferrum:metricsRefreshInterval")).toBe("0");

  for (const [to, title, empty] of [
    ["/proxies", "Proxies", "No proxies yet"], ["/consumers", "Consumers", "No consumers yet"],
    ["/plugins", "Plugins", "No plugin configs yet"], ["/upstreams", "Upstreams", "No upstreams yet"],
    ["/api-specs", "API Specs", "No API specs"],
  ] as const) {
    await act(async () => { await router.navigate({ to }); });
    await settle(() => expect(ui.host.querySelector("main")?.textContent).toContain(empty));
    expect(ui.host.querySelector("h1")?.textContent).toContain(title);
  }

  await act(async () => { await router.navigate({ to: "/missing-page" as "/" }); });
  await settle(() => expect(ui.host.querySelector("main")?.textContent).toContain("Page not found"));
  expect(ui.host.querySelector('a[href="/"]')).not.toBeNull();
  expect(ui.host.querySelector("header")).not.toBeNull();
  await click("Sign out");
  await settle(() => expect(ui.host.textContent).toContain("Local development sign in"));
  expect(ui.host.querySelector("main")).toBeNull();
  expect(requests.filter((request) => request.url.includes("/api/proxy/") && !request.url.includes("/admin/tls/"))
    .every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
}, 15000);

function gatewayFacing(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path.startsWith("/api/proxy/") || path.startsWith("/api/settings");
}

/**
 * Put the fixture behind a BFF whose `adminUrl` can be re-pointed: every
 * response names the current target, and a gateway-facing request declared
 * against any other target is refused before it reaches the fixture
 * (`server/gateway-target.ts`). A settings save that changes `adminUrl`
 * re-points it.
 */
function retargetableBff() {
  const bff = {
    target: "target-a",
    refused: [] as string[],
    // Another tab re-points the BFF just as this request arrives.
    repointOn: null as string | null,
    // An intermediary drops the target header from the refusal.
    stripRefusalTarget: false,
  };
  const fixture = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (bff.repointOn === `${request.method} ${path}`) {
      bff.target = "target-b";
      bff.repointOn = null;
    }
    const declared = request.headers.get(GATEWAY_TARGET_HEADER);
    if (gatewayFacing(request) && declared !== null && declared !== bff.target) {
      bff.refused.push(`${request.method} ${path}`);
      return Response.json(
        { code: "FERRUM_BFF_GATEWAY_TARGET_CHANGED" },
        { status: 409, headers: bff.stripRefusalTarget ? {} : { [GATEWAY_TARGET_HEADER]: bff.target } },
      );
    }
    const saved = request.method === "PUT" && path === "/api/settings"
      ? await request.clone().json() as { adminUrl?: string }
      : undefined;
    const response = await fixture(request);
    if (saved?.adminUrl && saved.adminUrl !== settings.adminUrl) bff.target = "target-b";
    const headers = new Headers(response.headers);
    headers.set(GATEWAY_TARGET_HEADER, bff.target);
    return new Response(response.body, { status: response.status, headers });
  }));
  return bff;
}

/**
 * Render the signed-in shell. The router is a module singleton that an earlier
 * test has already loaded, and a remounted `RouterProvider` keeps presenting
 * that test's last location instead of loading the fresh memory history, so
 * tests reach a page by navigating once the shell is up.
 */
async function openShell() {
  await ui.render(<App />);
  await settle(() => expect(ui.host.querySelector("main")).not.toBeNull());
}

async function openSettings() {
  await openShell();
  await act(async () => { await router.navigate({ to: "/settings" }); });
  await settle(() => expect(ui.host.textContent).toContain("Save Settings"));
}

function expectWorkspaceRetired() {
  expect(ui.host.textContent).toContain("Gateway target changed");
  expect(ui.host.textContent).not.toContain("Save Settings");
  expect(ui.host.querySelector("main")).toBeNull();
  for (const client of clients) expect(client.getQueryCache().getAll()).toEqual([]);
}

it("keeps drafts through same-target refreshes and retires a tab whose target another tab replaced", async () => {
  const bff = retargetableBff();
  await openSettings();
  expect(requests.filter(gatewayFacing).length).toBeGreaterThan(0);
  expect(requests.filter(gatewayFacing).every((request) => request.headers.get(GATEWAY_TARGET_HEADER) === "target-a"))
    .toBe(true);

  await fill(inputByLabel(ui.host, "JWT Issuer"), "drafted-against-a");
  await click("Test Connection");
  await settle(() => expect(ui.host.textContent).toContain("Connected (HTTP 200)"));
  expect(inputByLabel(ui.host, "JWT Issuer").value).toBe("drafted-against-a");

  // Another tab re-points the BFF at gateway B. This tab's draft, seeded
  // from A (adminUrl included), must not be saved to B.
  bff.target = "target-b";
  const answered = requests.length;
  await click("Save Settings");
  await settle(() => expect(ui.host.textContent).toContain("Gateway target changed"));
  expect(bff.refused).toContain("PUT /api/settings");
  expect(requests.slice(answered).filter(gatewayFacing)).toEqual([]);
  expectWorkspaceRetired();
  expect(document.body.textContent).not.toContain("Failed to save settings");
  expect(document.body.textContent).not.toContain("409");
}, 15000);

it("retires this tab's workspace once its own settings save re-points the BFF", async () => {
  const bff = retargetableBff();
  await openSettings();
  await fill(inputByLabel(ui.host, "Admin URL"), "https://gateway-b.example.test");
  await click("Save Settings");
  await settle(() => expect(ui.host.textContent).toContain("Gateway target changed"));

  const save = requests.find((request) => request.method === "PUT")!;
  expect(save.headers.get(GATEWAY_TARGET_HEADER)).toBe("target-a");
  expect(bff.target).toBe("target-b");
  expectWorkspaceRetired();
  expect(document.body.textContent).not.toContain("Settings saved successfully");
  const sent = requests.length;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(requests.slice(sent).filter(gatewayFacing)).toEqual([]);
}, 15000);

it.each([
  ["names the new target", false],
  ["lost its target header on the way back", true],
])("retires the workspace instead of offering a settings retry when the read is refused and the refusal %s", async (
  _refusal,
  stripped,
) => {
  const bff = retargetableBff();
  bff.stripRefusalTarget = stripped;
  await openShell();
  await act(async () => { await router.navigate({ to: "/tls" }); });
  await settle(() => expect(ui.host.querySelector("main")?.textContent).toContain("No TLS material found"));

  // Another tab re-points the BFF as this tab opens Settings: the read was
  // declared against A, so no answer from B can seed the form, and a retry
  // would be refused the same way.
  bff.repointOn = "GET /api/settings";
  const answered = requests.length;
  await act(async () => { void router.navigate({ to: "/settings" }); });
  await settle(() => expect(ui.host.textContent).toContain("Gateway target changed"));
  expect(bff.refused).toContain("GET /api/settings");
  expect(requests.slice(answered).some((request) => new URL(request.url).pathname === "/api/settings")).toBe(false);
  expectWorkspaceRetired();
  expect(document.body.textContent).not.toContain("Unable to load settings");
  expect(document.body.textContent).not.toContain("Retry");
  expect(document.body.textContent).not.toContain("409");
}, 15000);
