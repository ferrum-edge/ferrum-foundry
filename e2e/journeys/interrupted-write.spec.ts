/* ------------------------------------------------------------------ */
/*  A write whose outcome is unknown (issue #380)                      */
/* ------------------------------------------------------------------ */

/**
 * The gateway commits, and the answer never arrives. The client cannot tell
 * that from "the write never happened", and the two require opposite
 * responses — so the only safe behaviour is to report the outcome as unknown
 * and never replay it.
 *
 * Replaying a committed write is how one create becomes two, or how a
 * full-replacement PUT lands twice against a resource someone else has since
 * changed.
 */

import { expect, test, uniqueId, GatewayClient, NAMESPACE } from "../support/stack";

const CREATED = uniqueId("e2e-interrupted");

test.describe("an interrupted mutation", () => {
  test.afterAll(async () => {
    const gateway = new GatewayClient("admin", NAMESPACE);
    await gateway.session();
    const listed = await gateway.get<{ data: { id: string; name?: string }[] }>(
      "/upstreams?offset=0&limit=250",
    );
    for (const upstream of listed.body?.data ?? []) {
      if (upstream.name === CREATED) {
        await gateway.remove(`/upstreams/${upstream.id}?apply=sync`);
      }
    }
  });

  test("is reported, not replayed, when the gateway may already have committed", async ({
    adminPage: page,
    faults,
    gateway,
  }) => {
    // The request reaches the gateway and commits. The response is destroyed
    // on the way back, exactly once.
    await faults.arm({ method: "POST", path: "/upstreams", times: 1, dropAfterForward: true });

    await page.goto("/upstreams/new");
    await page.getByLabel("Name", { exact: true }).fill(CREATED);
    await page.getByRole("button", { name: "Add Target", exact: true }).click();
    await page.getByLabel("Host", { exact: true }).fill("demo-backend");
    await page.getByLabel("Port", { exact: true }).fill("8081");
    await page.getByRole("button", { name: "Add Target", exact: true }).last().click();
    await page.getByRole("button", { name: "Create Upstream" }).click();

    // Not a success. The BFF could not read an answer, so it reports the
    // upstream failure by its own code rather than inventing an outcome.
    //
    // Known gap, and deliberately asserted as it is rather than as it should
    // be: this ambiguous 502 is presented as a plain failure. The restore flow
    // presents the same condition as an explicit *unknown* outcome
    // (`docs/client-recovery.md`), which is the more honest shape for a write
    // that may have committed. Aligning ordinary writes with it is follow-up
    // work; the property that matters for safety — no replay — is asserted
    // below and does hold.
    await expect(page.getByText("Upstream created successfully")).toHaveCount(0);
    await expect(page.getByText("FERRUM_BFF_UPSTREAM_FAILURE").first()).toBeVisible({
      timeout: 40_000,
    });

    await faults.expectAllConsumed();

    // It did land. That is precisely why a replay would be wrong.
    const listed = await gateway.get<{ data: { id: string; name?: string }[] }>(
      "/upstreams?offset=0&limit=250",
    );
    const matches = (listed.body?.data ?? []).filter((upstream) => upstream.name === CREATED);
    expect(
      matches.length,
      "the interrupted write must not have been replayed into a duplicate",
    ).toBe(1);

    // And the operator's draft is still on the page, so nothing has to be
    // retyped to decide what to do next.
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(CREATED);
  });

  test("a refused write is not retried either", async ({ adminPage: page, faults, gateway }) => {
    const refused = uniqueId("e2e-refused");
    // A 503 on a write is not permission to send it again: it may have
    // committed before the failure was produced.
    await faults.arm({ method: "POST", path: "/upstreams", times: 1, status: 503 });

    await page.goto("/upstreams/new");
    await page.getByLabel("Name", { exact: true }).fill(refused);
    await page.getByRole("button", { name: "Add Target", exact: true }).click();
    await page.getByLabel("Host", { exact: true }).fill("demo-backend");
    await page.getByLabel("Port", { exact: true }).fill("8081");
    await page.getByRole("button", { name: "Add Target", exact: true }).last().click();
    await page.getByRole("button", { name: "Create Upstream" }).click();

    await expect(page.getByText(/the request was not replayed/i)).toBeVisible({
      timeout: 40_000,
    });
    await expect(page.getByText("Upstream created successfully")).toHaveCount(0);
    await faults.expectAllConsumed();

    // Exactly one attempt reached the forwarder, and it was the one that was
    // refused — so nothing was created behind the operator's back.
    const listed = await gateway.get<{ data: { name?: string }[] }>(
      "/upstreams?offset=0&limit=250",
    );
    expect((listed.body?.data ?? []).filter((upstream) => upstream.name === refused)).toEqual(
      [],
    );
  });
});
