/* ------------------------------------------------------------------ */
/*  Two tenants on one gateway (issue #380)                            */
/* ------------------------------------------------------------------ */

/**
 * Namespaces must stay separate across reads, edits, switches, and a delayed
 * response — the cases where a caching or binding mistake is invisible,
 * because every page still looks plausible while showing another tenant's
 * configuration.
 *
 * The issue asks for two namespaces holding *identical* resource ids. This
 * gateway does not allow that: a second namespace reusing an id is refused
 * with `409 Resource identity conflicts with an existing resource in the
 * namespace`, so ids are unique across the gateway rather than per namespace.
 * That is a stronger guarantee than the one the journey was written for, so
 * the first test pins it — if it ever relaxes, the confusable case becomes
 * reachable and this suite says so.
 */

import {
  expect,
  test,
  uniqueId,
  GatewayClient,
  NAMESPACE,
  NAMESPACE_B,
  selectNamespace,
} from "../support/stack";

const tenants = [
  { namespace: NAMESPACE, id: uniqueId("e2e-tenant-a"), backend: "tenant-a-backend.invalid" },
  { namespace: NAMESPACE_B, id: uniqueId("e2e-tenant-b"), backend: "tenant-b-backend.invalid" },
];

async function clientFor(namespace: string): Promise<GatewayClient> {
  const gateway = new GatewayClient("admin", namespace);
  await gateway.session();
  return gateway;
}

test.describe("namespace isolation", () => {
  test.beforeAll(async () => {
    for (const tenant of tenants) {
      const gateway = await clientFor(tenant.namespace);
      await gateway.send("POST", "/upstreams?apply=sync", {
        id: tenant.id,
        name: `shared-${tenant.namespace}`,
        algorithm: "round_robin",
        targets: [{ host: tenant.backend, port: 8081, weight: 1 }],
      });
    }
  });

  test.afterAll(async () => {
    for (const tenant of tenants) {
      const gateway = await clientFor(tenant.namespace);
      await gateway.remove(`/upstreams/${tenant.id}?apply=sync`);
    }
  });

  test("a resource id cannot be reused in another namespace", async () => {
    const other = await clientFor(NAMESPACE_B);
    const conflict = await other.send<{ error: string }>("POST", "/upstreams?apply=sync", {
      id: tenants[0].id,
      name: "reused-id",
      algorithm: "round_robin",
      targets: [{ host: "x.invalid", port: 8081, weight: 1 }],
    });

    expect(conflict.status, "an id reused across namespaces must be refused").toBe(409);
    expect(conflict.body?.error).toMatch(/identity conflicts/i);

    // And the refusal did not touch the original.
    const original = await clientFor(NAMESPACE);
    const read = await original.get<{ name: string }>(`/upstreams/${tenants[0].id}`);
    expect(read.body?.name).toBe(`shared-${NAMESPACE}`);
  });

  test("a resource is invisible from a namespace that does not hold it", async () => {
    const other = await clientFor(NAMESPACE_B);
    const crossRead = await other.get(`/upstreams/${tenants[0].id}`);
    expect(crossRead.status, "a namespace must not read another's resource").toBe(404);
  });

  test("switching namespaces re-reads the detail page for the new tenant", async ({
    adminPage: page,
  }) => {
    await page.goto(`/upstreams/${tenants[0].id}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `shared-${NAMESPACE}`,
    );
    await expect(page.getByText(`${tenants[0].backend}:8081`)).toBeVisible();

    // The editor is bound to `{ namespace, resourceId }`. A switch must
    // remount it rather than keep the previous tenant's fields on screen.
    await selectNamespace(page, NAMESPACE_B);

    await expect(page.getByText(`${tenants[0].backend}:8081`)).toHaveCount(0);
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  });

  test("a late response for the previous tenant cannot repaint the new one", async ({
    adminPage: page,
    faults,
  }) => {
    await page.goto(`/upstreams/${tenants[0].id}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `shared-${NAMESPACE}`,
    );

    // Hold tenant A's next read of this upstream — and only tenant A's: the
    // rule is namespace-bound, so tenant B's read of the same path is not
    // slowed. The answer is real, it just arrives after the switch.
    const DELAY_MS = 4_000;
    await faults.arm({
      method: "GET",
      path: `/upstreams/${tenants[0].id}`,
      namespace: NAMESPACE,
      delayMs: DELAY_MS,
      times: 1,
    });
    await page.reload();
    await selectNamespace(page, NAMESPACE_B);

    // Tenant B does not hold this id. The page reaches that conclusion only
    // after the query layer's retry ladder, so wait for the terminal state
    // rather than racing it — as the suite's other terminal-state checks do.
    await expect(page.getByText(/failed to load upstream configuration/i)).toBeVisible({
      timeout: 40_000,
    });

    // Let tenant A's held response land, then look again.
    await page.waitForTimeout(DELAY_MS + 1_000);
    await faults.expectAllConsumed();
    await expect(page.getByText(`${tenants[0].backend}:8081`)).toHaveCount(0);
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/failed to load upstream configuration/i)).toBeVisible();
  });

  test("a list shows only the namespace on screen", async ({ adminPage: page }) => {
    await page.goto("/upstreams");
    await selectNamespace(page, NAMESPACE);
    await expect(page.getByText(`shared-${NAMESPACE}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`shared-${NAMESPACE_B}`, { exact: true })).toHaveCount(0);

    await selectNamespace(page, NAMESPACE_B);
    await expect(page.getByText(`shared-${NAMESPACE_B}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`shared-${NAMESPACE}`, { exact: true })).toHaveCount(0);
  });
});
