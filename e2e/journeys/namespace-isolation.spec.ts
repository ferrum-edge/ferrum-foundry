/* ------------------------------------------------------------------ */
/*  Two tenants on one gateway (issue #380)                            */
/* ------------------------------------------------------------------ */

/**
 * Namespaces must stay separate across reads, edits, switches, and a delayed
 * response — the cases where a caching or binding mistake is invisible,
 * because every page still looks plausible while showing another tenant's
 * configuration.
 *
 * Ferrum Edge 0.9.x keys proxies, upstreams, plugin configurations, and API
 * specs on `(namespace, id)` (ferrum-edge 5db1d77a8), so two namespaces can
 * hold resources with the *same* id. That is the confusable case the issue
 * asks for: the same URL, the same id, two different tenants. The suite
 * covers it at the gateway (reads, writes, deletes, and lists stay with their
 * namespace) and in the browser (a switch, and a late answer for the previous
 * tenant, on a page both tenants hold). The distinct-id tenants cover the
 * other half: a namespace that does not hold an id cannot see it.
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

/** One id, held by both namespaces as two unrelated upstreams. */
const SHARED_ID = uniqueId("e2e-shared");
const sharedName = (namespace: string) => `same-id-${namespace}`;
const sharedBackend = (namespace: string) =>
  namespace === NAMESPACE ? "shared-a-backend.invalid" : "shared-b-backend.invalid";

function upstreamBody(id: string, name: string, backend: string) {
  return {
    id,
    name,
    algorithm: "round_robin",
    targets: [{ host: backend, port: 8081, weight: 1 }],
  };
}

async function clientFor(namespace: string): Promise<GatewayClient> {
  const gateway = new GatewayClient("admin", namespace);
  await gateway.session();
  return gateway;
}

test.describe("namespace isolation", () => {
  test.beforeAll(async () => {
    for (const tenant of tenants) {
      const gateway = await clientFor(tenant.namespace);
      const created = await gateway.send(
        "POST",
        "/upstreams?apply=sync",
        upstreamBody(tenant.id, `shared-${tenant.namespace}`, tenant.backend),
      );
      expect([200, 201], `creating ${tenant.id}`).toContain(created.status);
      const shared = await gateway.send(
        "POST",
        "/upstreams?apply=sync",
        upstreamBody(SHARED_ID, sharedName(tenant.namespace), sharedBackend(tenant.namespace)),
      );
      expect([200, 201], `creating ${SHARED_ID} in ${tenant.namespace}`).toContain(shared.status);
    }
  });

  test.afterAll(async () => {
    for (const tenant of tenants) {
      const gateway = await clientFor(tenant.namespace);
      await gateway.remove(`/upstreams/${tenant.id}?apply=sync`);
      await gateway.remove(`/upstreams/${SHARED_ID}?apply=sync`);
    }
  });

  test("the same id in two namespaces is two independent resources", async () => {
    // Its own id, so deleting one side cannot disturb the other journeys.
    const id = uniqueId("e2e-same-id");
    const a = await clientFor(NAMESPACE);
    const b = await clientFor(NAMESPACE_B);
    type Upstream = { name: string; targets: { host: string }[] };
    type UpstreamPage = { data: { id: string; name: string }[] };
    const namesOf = (page: UpstreamPage | undefined) =>
      (page?.data ?? []).filter((upstream) => upstream.id === id).map((upstream) => upstream.name);
    try {
      const inA = await a.send(
        "POST",
        "/upstreams?apply=sync",
        upstreamBody(id, "same-a", "same-a.invalid"),
      );
      expect([200, 201]).toContain(inA.status);
      const inB = await b.send(
        "POST",
        "/upstreams?apply=sync",
        upstreamBody(id, "same-b", "same-b.invalid"),
      );
      expect([200, 201], "a second namespace may hold the same id").toContain(inB.status);

      // Each namespace reads its own resource, not the other's.
      const readA = await a.get<Upstream>(`/upstreams/${id}`);
      const readB = await b.get<Upstream>(`/upstreams/${id}`);
      expect(readA.body?.name).toBe("same-a");
      expect(readA.body?.targets.map((target) => target.host)).toEqual(["same-a.invalid"]);
      expect(readB.body?.name).toBe("same-b");
      expect(readB.body?.targets.map((target) => target.host)).toEqual(["same-b.invalid"]);

      // A write in one namespace does not reach the other.
      const updated = await b.send(
        "PUT",
        `/upstreams/${id}?apply=sync`,
        upstreamBody(id, "same-b-renamed", "same-b.invalid"),
      );
      expect(updated.status).toBe(200);
      expect((await b.get<Upstream>(`/upstreams/${id}`)).body?.name).toBe("same-b-renamed");
      const afterEdit = await a.get<Upstream>(`/upstreams/${id}`);
      expect(afterEdit.body?.name, "B's edit reached A").toBe("same-a");

      // Each list holds exactly its own copy.
      const listA = await a.get<UpstreamPage>("/upstreams?offset=0&limit=250");
      expect(namesOf(listA.body)).toEqual(["same-a"]);
      const listB = await b.get<UpstreamPage>("/upstreams?offset=0&limit=250");
      expect(namesOf(listB.body)).toEqual(["same-b-renamed"]);

      // A delete in one namespace leaves the other's resource in place.
      const deleted = await b.send("DELETE", `/upstreams/${id}?apply=sync`);
      expect([200, 204]).toContain(deleted.status);
      expect((await b.get(`/upstreams/${id}`)).status).toBe(404);
      const survivor = await a.get<Upstream>(`/upstreams/${id}`);
      expect(survivor.status, "B's delete removed A's resource").toBe(200);
      expect(survivor.body?.name).toBe("same-a");
    } finally {
      await b.remove(`/upstreams/${id}?apply=sync`);
      await a.remove(`/upstreams/${id}?apply=sync`);
    }
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

  test("switching namespaces on an id both hold shows the new tenant's resource", async ({
    adminPage: page,
  }) => {
    await page.goto(`/upstreams/${SHARED_ID}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(sharedName(NAMESPACE));
    await expect(page.getByText(`${sharedBackend(NAMESPACE)}:8081`)).toBeVisible();

    // Same URL, same id, a different resource. A stale binding or cache entry
    // would keep tenant A's fields here and look entirely plausible.
    await selectNamespace(page, NAMESPACE_B);

    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(sharedName(NAMESPACE_B));
    await expect(page.getByText(`${sharedBackend(NAMESPACE_B)}:8081`)).toBeVisible();
    await expect(page.getByText(`${sharedBackend(NAMESPACE)}:8081`)).toHaveCount(0);
  });

  test("a late response for the previous tenant cannot repaint an id both hold", async ({
    adminPage: page,
    faults,
  }) => {
    await page.goto(`/upstreams/${SHARED_ID}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(sharedName(NAMESPACE));

    // Hold only tenant A's next read of this path; tenant B's read of the very
    // same path goes straight through and answers first.
    const DELAY_MS = 4_000;
    await faults.arm({
      method: "GET",
      path: `/upstreams/${SHARED_ID}`,
      namespace: NAMESPACE,
      delayMs: DELAY_MS,
      times: 1,
    });
    await page.reload();
    await selectNamespace(page, NAMESPACE_B);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(sharedName(NAMESPACE_B));

    // Let tenant A's held response land, then look again.
    await page.waitForTimeout(DELAY_MS + 1_000);
    await faults.expectAllConsumed();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(sharedName(NAMESPACE_B));
    await expect(page.getByText(`${sharedBackend(NAMESPACE_B)}:8081`)).toBeVisible();
    await expect(page.getByText(`${sharedBackend(NAMESPACE)}:8081`)).toHaveCount(0);
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
