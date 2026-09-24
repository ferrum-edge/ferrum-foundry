/* ------------------------------------------------------------------ */
/*  The operator journey, end to end (issue #380)                      */
/* ------------------------------------------------------------------ */

/**
 * Admin logs in, creates an upstream and a proxy, attaches key authentication,
 * creates a consumer credential, and then proves with two data-plane requests
 * that the route refuses an anonymous caller and serves an authenticated one.
 *
 * Every step is driven through the browser. Every claim the UI makes is
 * checked against the gateway's own state, because a save that renders as a
 * success is not evidence that the configuration is live — that is what the
 * data-plane requests at the end are for.
 */

import {
  callDataPlane,
  expect,
  test,
  uniqueId,
  type Identity,
} from "../support/stack";

const BACKEND_HOST = process.env.FERRUM_STARTER_BACKEND_HOST ?? "demo-backend";
const BACKEND_PORT = process.env.FERRUM_STARTER_BACKEND_PORT ?? "8081";

interface Created {
  /** Names the operator types; ids the gateway assigns. Both are needed: the
   *  UI identifies resources by name, the gateway by id. */
  upstreamName: string;
  upstreamId: string;
  proxyName: string;
  proxyId: string;
  pluginId: string;
  consumerName: string;
  consumerId: string;
  listenPath: string;
  apiKey: string;
}

test.describe("first route, first authenticated request", () => {
  const created: Created = {
    upstreamName: uniqueId("e2e-upstream"),
    upstreamId: "",
    proxyName: uniqueId("e2e-route"),
    proxyId: "",
    pluginId: "",
    consumerName: uniqueId("e2e-consumer"),
    consumerId: "",
    listenPath: `/${uniqueId("e2e")}`,
    // Filled in from the UI's copy-once receipt.
    apiKey: "",
  };

  test.afterAll(async () => {
    const { GatewayClient } = await import("../support/stack");
    const gateway = new GatewayClient("admin" as Identity);
    await gateway.session();
    for (const [path, id] of [
      [`/plugins/config`, created.pluginId],
      [`/proxies`, created.proxyId],
      [`/consumers`, created.consumerId],
      [`/upstreams`, created.upstreamId],
    ] as const) {
      if (!id) continue;
      const suffix = path === "/proxies" ? "&cleanup_orphaned_upstream=false" : "";
      await gateway.remove(`${path}/${id}?apply=sync${suffix}`);
    }
  });

  test("an admin creates an upstream through the UI", async ({ adminPage: page, gateway }) => {
    await page.goto("/upstreams/new");
    await page.getByLabel("Name", { exact: true }).fill(created.upstreamName);
    await page.getByRole("button", { name: "Add Target", exact: true }).click();
    await page.getByLabel("Host", { exact: true }).fill(BACKEND_HOST);
    await page.getByLabel("Port", { exact: true }).fill(BACKEND_PORT);
    await page.getByRole("button", { name: "Add Target", exact: true }).last().click();

    await page.getByRole("button", { name: "Create Upstream" }).click();
    // Wait for the gateway's answer, not for a URL that also matches the page
    // we started on — a post-condition that is already true proves nothing.
    await expect(page.getByText("Upstream created successfully")).toBeVisible();

    // The gateway's own record, not the page's word for it.
    const listed = await gateway.get<{ data: { id: string; name?: string }[] }>(
      "/upstreams?offset=0&limit=250",
    );
    expect(listed.status).toBe(200);
    const match = listed.body?.data.find((upstream) => upstream.name === created.upstreamName);
    expect(match, "the upstream the UI reported creating").toBeTruthy();
    created.upstreamId = match!.id;
  });

  test("an admin creates a proxy that routes to it", async ({ adminPage: page, gateway }) => {
    await page.goto("/proxies/new");
    await page.getByLabel("Name", { exact: true }).fill(created.proxyName);
    await page.getByLabel("Listen Path", { exact: true }).fill(created.listenPath);
    await page.getByLabel("Backend Host", { exact: true }).fill(BACKEND_HOST);
    await page.getByLabel("Backend Port", { exact: true }).fill(BACKEND_PORT);

    // Plaintext to the disposable backend. The scheme is a real choice the
    // form makes explicit; it is not a protocol the gateway guesses.
    await page.getByRole("combobox", { name: "Backend Scheme" }).click();
    await page.getByRole("option", { name: /^HTTP \(/ }).click();

    await page.getByRole("button", { name: "Create Proxy" }).click();
    await expect(page.getByText("Proxy created successfully")).toBeVisible();

    const listed = await gateway.get<{ data: { id: string; name?: string; listen_path?: string }[] }>(
      "/proxies?offset=0&limit=250",
    );
    const match = listed.body?.data.find((proxy) => proxy.name === created.proxyName);
    expect(match, "the proxy the UI reported creating").toBeTruthy();
    expect(match!.listen_path).toBe(created.listenPath);
    created.proxyId = match!.id;

    // Live, and unauthenticated — which is exactly why the next step matters.
    const open = await callDataPlane(`${created.listenPath}/hello`);
    expect(open.status, "a new route should serve traffic immediately").toBe(200);
  });

  test("key authentication created in the UI is attached to its proxy", async ({
    adminPage: page,
    gateway,
  }) => {
    await page.goto("/plugins/new");

    await page.getByRole("combobox", { name: "Plugin Name" }).click();
    await page.getByRole("option", { name: "Key Auth", exact: true }).click();

    await page.getByRole("combobox", { name: "Scope" }).click();
    await page.getByRole("option", { name: "Proxy", exact: true }).click();

    // The proxy picker searches the catalog rather than asking for an id.
    await page.getByPlaceholder(/search proxies by name, path, or ID/i).fill(created.proxyName);
    await page.getByRole("button", { name: new RegExp(created.proxyName) }).first().click();

    await page.getByRole("button", { name: "Create Plugin" }).click();
    await expect(page.getByText("Plugin configuration created successfully")).toBeVisible();

    const configs = await gateway.get<{ data: { id: string; plugin_name: string; proxy_id?: string }[] }>(
      "/plugins/config?offset=0&limit=250",
    );
    const match = configs.body?.data.find(
      (config) => config.plugin_name === "key_auth" && config.proxy_id === created.proxyId,
    );
    expect(match, "a key_auth configuration bound to this proxy").toBeTruthy();
    created.pluginId = match!.id;

    // A proxy-scoped configuration runs only once the proxy's own association
    // list names it. Edge 0.9.x writes that association on create, and the UI
    // reads it back and writes it only if it is missing; either way the proxy
    // must list it, or the route stays open while everything looks configured.
    const proxy = await gateway.get<{ plugins: { plugin_config_id: string }[] }>(
      `/proxies/${created.proxyId}`,
    );
    expect(
      proxy.body?.plugins.map((association) => association.plugin_config_id),
      "the plugin must be associated with the proxy, not merely configured for it",
    ).toContain(created.pluginId);
  });

  test("a generated credential is shown once, copied, and redacted afterwards", async ({
    adminPage: page,
    gateway,
  }) => {
    await page.goto("/consumers/new");
    await page.getByLabel("Username", { exact: true }).fill(created.consumerName);
    await page.getByRole("button", { name: "Credentials" }).click();
    // The operator does not invent the key; the UI generates it.
    await page.getByRole("button", { name: "Generate", exact: true }).first().click();
    await expect(page.getByLabel("Key Auth", { exact: true })).not.toHaveValue("");

    await page.getByRole("button", { name: "Create Consumer" }).click();
    await expect(page.getByText("Consumer created successfully")).toBeVisible();

    // The copy-once receipt is the only place the key is ever shown again.
    // Take it from there, as the operator would.
    const receipt = page.getByLabel("API key 1", { exact: true });
    await expect(receipt).toBeVisible();
    created.apiKey = await receipt.inputValue();
    expect(created.apiKey.length, "the receipt must carry the generated key").toBeGreaterThan(16);
    await page.getByRole("button", { name: "I have saved these credentials" }).click();

    const consumers = await gateway.get<{ data: { id: string; username: string }[] }>(
      "/consumers?offset=0&limit=250",
    );
    const match = consumers.body?.data.find(
      (consumer) => consumer.username === created.consumerName,
    );
    expect(match, "the consumer the UI reported creating").toBeTruthy();
    created.consumerId = match!.id;

    // An ordinary read never returns the key again, and neither does the UI.
    const stored = await gateway.get<{ credentials?: { keyauth?: { key: string }[] } }>(
      `/consumers/${created.consumerId}`,
    );
    expect(stored.body?.credentials?.keyauth?.[0]?.key).toBe("[REDACTED]");
    await expect(page).toHaveURL(new RegExp(`/consumers/${created.consumerId}$`));
    await expect(page.getByText(created.apiKey)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(created.apiKey)).toHaveCount(0);
  });

  test("the route now refuses an anonymous caller and serves an authenticated one", async () => {
    // The only claim that matters, and the one no save status can make.
    const anonymous = await callDataPlane(`${created.listenPath}/hello`);
    expect(anonymous.status, "anonymous must be refused at the gateway").toBe(401);

    const authenticated = await callDataPlane(`${created.listenPath}/hello`, {
      "X-API-Key": created.apiKey,
    });
    expect(authenticated.status).toBe(200);

    const payload = JSON.parse(authenticated.body) as { saw_api_key: boolean };
    expect(
      payload.saw_api_key,
      "key_auth hides credentials by default; the backend must not receive the key",
    ).toBe(false);

    // A wrong key is refused, so the 200 above was not the route being open.
    const wrong = await callDataPlane(`${created.listenPath}/hello`, {
      "X-API-Key": "not-the-issued-key",
    });
    expect(wrong.status).toBe(401);
  });
});
