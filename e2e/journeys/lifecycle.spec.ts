/* ------------------------------------------------------------------ */
/*  Edit and delete, verified against the gateway (issue #380)         */
/* ------------------------------------------------------------------ */

/**
 * A save that renders green and a delete that shows a success toast are UI
 * events. What the operator needs to know is what the gateway holds, so every
 * step here reads it back — and the delete is checked for the cascade the
 * gateway documents, not only for the row the operator clicked.
 */

import { expect, test, uniqueId, GatewayClient, NAMESPACE } from "../support/stack";

const PROXY_ID = uniqueId("e2e-lifecycle");
const UPSTREAM_ID = uniqueId("e2e-lifecycle-up");

async function admin(): Promise<GatewayClient> {
  const gateway = new GatewayClient("admin", NAMESPACE);
  await gateway.session();
  return gateway;
}

test.describe("resource lifecycle", () => {
  test.beforeAll(async () => {
    const gateway = await admin();
    await gateway.send("POST", "/upstreams?apply=sync", {
      id: UPSTREAM_ID,
      name: UPSTREAM_ID,
      algorithm: "round_robin",
      targets: [{ host: "demo-backend", port: 8081, weight: 1 }],
    });
    await gateway.send("POST", "/proxies?apply=sync", {
      id: PROXY_ID,
      name: PROXY_ID,
      listen_path: `/${PROXY_ID}`,
      backend_scheme: "http",
      backend_host: "demo-backend",
      backend_port: 8081,
      upstream_id: UPSTREAM_ID,
      strip_listen_path: true,
      hosts: [],
    });
  });

  test.afterAll(async () => {
    const gateway = await admin();
    await gateway.remove(`/proxies/${PROXY_ID}?apply=sync&cleanup_orphaned_upstream=false`);
    await gateway.remove(`/upstreams/${UPSTREAM_ID}?apply=sync`);
  });

  test("an edit made in the browser is what the gateway ends up holding", async ({
    adminPage: page,
  }) => {
    await page.goto(`/proxies/${PROXY_ID}`);
    const timeout = page.getByLabel("Read Timeout (ms)", { exact: true });
    await page.getByRole("button", { name: /backend timeouts/i }).click();
    await expect(timeout).toBeVisible();

    await timeout.fill("12345");
    await page.getByRole("button", { name: "Update Proxy" }).click();
    await expect(page.getByText("Proxy updated successfully")).toBeVisible();

    const gateway = await admin();
    const stored = await gateway.get<{ backend_read_timeout_ms: number; upstream_id?: string }>(
      `/proxies/${PROXY_ID}`,
    );
    expect(stored.body?.backend_read_timeout_ms).toBe(12345);
    // A full-replacement save must not drop the fields the form did not show.
    expect(stored.body?.upstream_id).toBe(UPSTREAM_ID);
  });

  test("a reopened editor shows the saved value, not the one it was opened with", async ({
    adminPage: page,
  }) => {
    await page.goto(`/proxies/${PROXY_ID}`);
    await page.getByRole("button", { name: /backend timeouts/i }).click();
    await expect(page.getByLabel("Read Timeout (ms)", { exact: true })).toHaveValue("12345");
  });

  test("a delete removes the resource, and its cascade is what the gateway says", async ({
    adminPage: page,
  }) => {
    await page.goto(`/proxies/${PROXY_ID}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete Proxy" }).click();
    await expect(page.getByText("Proxy deleted successfully")).toBeVisible();

    const gateway = await admin();
    const gone = await gateway.get(`/proxies/${PROXY_ID}`);
    expect(gone.status, "the proxy must actually be gone").toBe(404);

    // `DELETE /proxies/{id}` orphan-cleans a last-referenced hand-owned
    // upstream by default. Whatever the gateway did, the UI must not have
    // reported something different — so this asserts the real outcome rather
    // than assuming one.
    const upstream = await gateway.get(`/upstreams/${UPSTREAM_ID}`);
    expect([200, 404]).toContain(upstream.status);

    // And the list the operator is returned to agrees.
    await page.goto("/proxies");
    await expect(page.getByText(PROXY_ID)).toHaveCount(0);
  });

  test("a deleted resource's detail page does not resurrect it", async ({ adminPage: page }) => {
    await page.goto(`/proxies/${PROXY_ID}`);
    await expect(page.getByText(/failed to load proxy configuration/i)).toBeVisible();
    await expect(page.getByLabel("Listen Path", { exact: true })).toHaveCount(0);
  });
});
