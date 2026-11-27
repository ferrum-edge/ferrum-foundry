/* ------------------------------------------------------------------ */
/*  Two operators editing one proxy, verified against the gateway      */
/* ------------------------------------------------------------------ */

/**
 * Two browser sessions open the same proxy. The first saves; the second,
 * still holding the version it opened, must not silently revert that save.
 * The write guard (docs/concurrent-edits.md) refuses the stale save, the
 * gateway keeps the first operator's value, and the second operator can
 * reload and then save on top of it. Unit and contract tests cover each
 * piece; this is the browser-to-gateway proof.
 */

import { expect, test, uniqueId, GatewayClient, NAMESPACE } from "../support/stack";
import type { Page } from "@playwright/test";

const BACKEND_TIMEOUTS_PATTERN = /backend timeouts/i;
const CHANGED_AFTER_OPEN_PATTERN = /changed after you opened it/i;
const NOT_SAVED_PATTERN = /were not saved/i;

const PROXY_ID = uniqueId("e2e-two-session");

async function admin(): Promise<GatewayClient> {
  const gateway = new GatewayClient("admin", NAMESPACE);
  await gateway.session();
  return gateway;
}

/** Open the proxy editor and its Backend timeouts section; return the field. */
async function openReadTimeout(page: Page) {
  await page.goto(`/proxies/${PROXY_ID}`);
  const timeout = page.getByLabel("Read Timeout (ms)", { exact: true });
  await page.getByRole("button", { name: BACKEND_TIMEOUTS_PATTERN }).click();
  await expect(timeout).toBeVisible();
  return timeout;
}

async function storedReadTimeout(): Promise<number | undefined> {
  const gateway = await admin();
  const stored = await gateway.get<{ backend_read_timeout_ms: number }>(`/proxies/${PROXY_ID}`);
  expect(stored.status).toBe(200);
  return stored.body?.backend_read_timeout_ms;
}

test.describe("two sessions editing one proxy", () => {
  test.beforeAll(async () => {
    const gateway = await admin();
    const proxy = await gateway.send("POST", "/proxies?apply=sync", {
      id: PROXY_ID,
      name: PROXY_ID,
      listen_path: `/${PROXY_ID}`,
      backend_scheme: "http",
      backend_host: "demo-backend",
      backend_port: 8081,
      backend_read_timeout_ms: 10000,
      strip_listen_path: true,
      hosts: [],
    });
    expect([200, 201], `creating ${PROXY_ID}`).toContain(proxy.status);
  });

  test.afterAll(async () => {
    const gateway = await admin();
    await gateway.remove(`/proxies/${PROXY_ID}?apply=sync`);
  });

  test("a stale save is refused, keeps the other session's change, and can be redone after a reload", async ({
    signIn,
  }) => {
    const { page: second } = await signIn("admin");
    const { page: first } = await signIn("admin");

    // The second operator opens the editor first, seeded with 10000.
    const secondTimeout = await openReadTimeout(second);
    await expect(secondTimeout).toHaveValue("10000");

    // The first operator opens it afterwards and saves 11111.
    const firstTimeout = await openReadTimeout(first);
    await firstTimeout.fill("11111");
    await first.getByRole("button", { name: "Update Proxy" }).click();
    await expect(first.getByText("Proxy updated successfully")).toBeVisible();
    expect(await storedReadTimeout()).toBe(11111);

    // The second operator saves a draft built on the version it opened.
    await secondTimeout.fill("22222");
    await second.getByRole("button", { name: "Update Proxy" }).click();
    const conflict = second.getByRole("dialog");
    await expect(conflict.getByText(CHANGED_AFTER_OPEN_PATTERN)).toBeVisible();
    await expect(conflict.getByText(NOT_SAVED_PATTERN)).toBeVisible();

    // The gateway is the witness: the first operator's save survived.
    expect(await storedReadTimeout()).toBe(11111);

    // Reloading drops the draft and shows what the gateway holds now.
    await conflict.getByRole("button", { name: "Discard my draft and reload" }).click();
    await expect(second.getByRole("dialog")).toHaveCount(0);
    const reloaded = second.getByLabel("Read Timeout (ms)", { exact: true });
    if (!(await reloaded.isVisible())) {
      await second.getByRole("button", { name: BACKEND_TIMEOUTS_PATTERN }).click();
    }
    await expect(reloaded).toHaveValue("11111");

    // On the fresh version, the second operator's save goes through.
    await reloaded.fill("33333");
    await second.getByRole("button", { name: "Update Proxy" }).click();
    await expect(second.getByText("Proxy updated successfully")).toBeVisible();
    expect(await storedReadTimeout()).toBe(33333);
  });
});
