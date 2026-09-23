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

    // Not a success, and not a failure either. The BFF could not read an
    // answer, so Foundry cannot know whether the gateway committed — and it
    // says exactly that, in the same shape the restore flow uses
    // (`docs/client-recovery.md`). "Not committed" would be a guess, and here
    // it would be the wrong one.
    await expect(page.getByText("Upstream created successfully")).toHaveCount(0);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Outcome unknown" })).toBeVisible({
      timeout: 40_000,
    });
    await expect(dialog.getByText(/did not replay it/i)).toBeVisible();
    // The form's own toast says the same thing rather than "failed".
    await expect(
      page.getByText(/^Outcome unknown: the gateway may already have committed this change/),
    ).toBeVisible();
    // The BFF's own code stays visible for diagnosis.
    await expect(dialog.getByText(/FERRUM_BFF_UPSTREAM_FAILURE/)).toBeVisible();
    await dialog.getByRole("button", { name: "Dismiss" }).click();

    // The live-apply banner keeps the report after the dialog is gone, bound to
    // the namespace and path of the write it describes.
    const banner = page.getByRole("status").filter({ hasText: "Outcome unknown" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("this change may have committed");
    await expect(banner).toContainText("The request was not replayed");
    await expect(banner).toContainText(`Namespace: ${NAMESPACE}`);
    await expect(banner).toContainText("/api/proxy/upstreams");
    await expect(page.getByText("Change was not committed")).toHaveCount(0);

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
