import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { router } from "./router";
import { setCsrfToken } from "@/api/client";
import { resetGatewayMetadata } from "@/api/gatewayMetadata";
import { inputByLabel } from "@/test/fields";
import { BasedRequest, click, createHarness, fill, page, selectOption, settle } from "@/test/__tests__/harness";
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
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
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
    if (gatewayPath in meshResponses) return Response.json(meshResponses[gatewayPath]);
    if (["admin/tls/inventory", "proxies", "consumers", "upstreams", "plugins/config"].includes(gatewayPath)) {
      return Response.json(page([]));
    }
    if (gatewayPath === "api-specs") return Response.json({ items: [], offset: 0, limit: 250, total: 0, next_offset: null });
    throw new Error(`Unexpected application request: ${request.method} ${path}`);
  }));
  router.update({ history: createMemoryHistory({ initialEntries: ["/tls"] }) });
});

afterEach(async () => {
  await ui.dispose();
  for (const client of clients) client.clear();
  setCsrfToken(null);
  resetGatewayMetadata();
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
