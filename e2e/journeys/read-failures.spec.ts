/* ------------------------------------------------------------------ */
/*  A failed read must not look like an answer (issue #380)            */
/* ------------------------------------------------------------------ */

/**
 * Two failure modes with opposite correct behaviours:
 *
 *  - A *transient* failure recovers. The operator should not be left with a
 *    modal about a request that has since succeeded.
 *  - An *unavailable* read is unavailable. It must never render as a healthy
 *    empty collection — "no proxies" and "we could not ask" are different
 *    facts, and only one of them means it is safe to create one.
 *
 * Every failure here is armed and consumed exactly. Nothing waits for a flake.
 */

import { expect, test, uniqueId, GatewayClient, NAMESPACE } from "../support/stack";

const PROXY_ID = uniqueId("e2e-read");

test.describe("read failures", () => {
  test.beforeAll(async () => {
    const gateway = new GatewayClient("admin", NAMESPACE);
    await gateway.session();
    await gateway.send("POST", "/proxies?apply=sync", {
      id: PROXY_ID,
      name: PROXY_ID,
      listen_path: `/${PROXY_ID}`,
      backend_scheme: "http",
      backend_host: "demo-backend",
      backend_port: 8081,
      strip_listen_path: true,
      hosts: [],
    });
  });

  test.afterAll(async () => {
    const gateway = new GatewayClient("admin", NAMESPACE);
    await gateway.session();
    await gateway.remove(`/proxies/${PROXY_ID}?apply=sync&cleanup_orphaned_upstream=false`);
  });

  test("a transient failure recovers without leaving an error behind", async ({
    adminPage: page,
    faults,
  }) => {
    // One 503. The client's own retry policy covers a single transient
    // failure on a read, so the operator should never see it.
    await faults.arm({ method: "GET", path: "/proxies", times: 1, status: 503 });

    await page.goto("/proxies");

    await expect(page.getByText(PROXY_ID).first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/failed to load proxies/i)).toHaveCount(0);

    // The failure really did happen; the journey did not pass by not testing.
    await faults.expectAllConsumed();
    const state = await faults.state();
    expect(state.blocked).toBeGreaterThan(0);
  });

  test("an unavailable read is not rendered as an empty collection", async ({
    adminPage: page,
    faults,
  }) => {
    // More failures than the client and query layers will retry, so the
    // outcome is "we could not ask" rather than "we asked and there is
    // nothing". The arming is still exact: the count is consumed, not looped.
    await faults.arm({ method: "GET", path: "/proxies", times: 200, status: 503 });

    await page.goto("/proxies");

    // The retry ladder is deliberate, so this waits for the terminal state
    // rather than asserting on a still-loading page.
    await expect(page.getByText(/failed to load proxies/i)).toBeVisible({
      timeout: 40_000,
    });
    // The empty state would invite an operator to create a proxy that may
    // already exist. It must not appear.
    await expect(page.getByText(/no proxies yet/i)).toHaveCount(0);
    await expect(page.getByText(/create your first proxy/i)).toHaveCount(0);
  });

  test("a failed background read keeps the operator's unsaved draft", async ({
    adminPage: page,
    faults,
  }) => {
    await page.goto(`/proxies/${PROXY_ID}`);
    const listenPath = page.getByLabel("Listen Path", { exact: true });
    await expect(listenPath).toHaveValue(`/${PROXY_ID}`);

    // An unsaved edit.
    const draft = `/${PROXY_ID}-edited`;
    await listenPath.fill(draft);

    // Every read of this proxy now fails — more times than the client and
    // query layers will retry, so the refetch really ends in an error.
    const blockedBefore = (await faults.state()).blocked;
    await faults.arm({ method: "GET", path: `/proxies/${PROXY_ID}`, times: 50, status: 503 });

    // Make the cached read stale (the app keeps reads fresh for 30s) and
    // return to the tab, which is what triggers a background refetch for a
    // real operator. Only Date.now is skewed; timers stay real, so the retry
    // ladder runs exactly as it would in production.
    await page.evaluate(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 31_000;
      // Bubbling, as the browser's own event does: the query layer listens
      // on window, so a non-bubbling synthetic event would never reach it
      // and this journey would pass without any refetch happening.
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    });

    // The failure is reported as a refresh problem, not as a missing proxy…
    await expect(page.getByText(/proxy configuration could not refresh/i)).toBeVisible({
      timeout: 40_000,
    });
    await expect(page.getByText(/failed to load proxy configuration/i)).toHaveCount(0);
    // …and the draft is exactly where the operator left it.
    await expect(listenPath).toHaveValue(draft);

    const state = await faults.state();
    expect(
      state.blocked - blockedBefore,
      "the background refetch must actually have hit the armed failures",
    ).toBeGreaterThan(0);
  });
});
