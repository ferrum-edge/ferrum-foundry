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
    apiKey: `e2e-key-${uniqueId("k")}`,
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

  test("attaching key authentication takes two steps, and the UI does both", async ({
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

    // The second step is the one a hand-written script forgets: a
    // proxy-scoped configuration is not attached until the proxy's own
    // association list names it. Creating it through the UI does both.
    const proxy = await gateway.get<{ plugins: { plugin_config_id: string }[] }>(
      `/proxies/${created.proxyId}`,
    );
    expect(
      proxy.body?.plugins.map((association) => association.plugin_config_id),
      "the plugin must be associated with the proxy, not merely configured for it",
    ).toContain(created.pluginId);
  });

  test("a consumer credential is shown once and redacted afterwards", async ({
    adminPage: page,
    gateway,
  }) => {
    await page.goto("/consumers/new");
    await page.getByLabel("Username", { exact: true }).fill(created.consumerName);
    await page.getByRole("button", { name: "Credentials" }).click();
    await page.getByLabel("Key Auth", { exact: true }).fill(created.apiKey);

    await page.getByRole("button", { name: "Create Consumer" }).click();
    await expect(page.getByText("Consumer created successfully")).toBeVisible();

    const consumers = await gateway.get<{ data: { id: string; username: string }[] }>(
      "/consumers?offset=0&limit=250",
    );
    const match = consumers.body?.data.find(
      (consumer) => consumer.username === created.consumerName,
    );
    expect(match, "the consumer the UI reported creating").toBeTruthy();
    created.consumerId = match!.id;

    // An ordinary read never returns the key again. An operator who did not
    // copy it has to rotate, and the UI must not pretend otherwise.
    const stored = await gateway.get<{ credentials?: { keyauth?: { key: string }[] } }>(
      `/consumers/${created.consumerId}`,
    );
    const storedKey = stored.body?.credentials?.keyauth?.[0]?.key;
    expect(storedKey, "a stored credential must not come back in the clear").not.toBe(
      created.apiKey,
    );
    expect(storedKey).toBe("[REDACTED]");

    await page.goto(`/consumers/${created.consumerId}`);
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
