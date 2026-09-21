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

  test("a failed read for the previous tenant cannot repaint the new one", async ({
    adminPage: page,
    faults,
  }) => {
    await page.goto(`/upstreams/${tenants[0].id}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `shared-${NAMESPACE}`,
    );

    // Whatever this read eventually answers belongs to the namespace it was
    // issued under. It must not reach the page after the switch.
    await faults.arm({
      method: "GET",
      path: `/upstreams/${tenants[0].id}`,
      times: 3,
      status: 503,
    });
    await selectNamespace(page, NAMESPACE_B);

    await expect(page.getByText(`${tenants[0].backend}:8081`)).toHaveCount(0);
    await expect(page.getByText(`shared-${NAMESPACE}`)).toHaveCount(0);
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
