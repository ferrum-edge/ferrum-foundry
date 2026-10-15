/* ------------------------------------------------------------------ */
/*  Strict style-src in a real browser (issue #594)                    */
/* ------------------------------------------------------------------ */

/**
 * The production policy has no `style-src 'unsafe-inline'`. Radix still
 * injects <style> elements at runtime: the scroll lock behind Dialog and
 * Select, and the Select viewport's own rules. They must carry the
 * per-response nonce, or the browser drops them and fires a
 * `securitypolicyviolation`. A unit test cannot see that, so this journey
 * opens both primitives and requires that their styles applied and that no
 * violation fired.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "../support/stack";

type ViolationWindow = Window & { __cspViolations?: string[] };

/** The style-src directive of a response's policy. */
function styleSrc(policy: string | undefined): string {
  const directive = (policy ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("style-src "));
  expect(directive, "the shell's policy has a style-src directive").toBeTruthy();
  return directive!;
}

/** The scroll lock's injected <style> applied: the body is locked and hidden. */
async function expectScrollLockApplied(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.body.hasAttribute("data-scroll-locked")
          ? getComputedStyle(document.body).overflow
          : "not locked",
      ),
    )
    .toBe("hidden");
}

test.describe("content security policy", () => {
  test("Radix's runtime styles apply under a style-src with no unsafe-inline", async ({
    adminPage: page,
  }) => {
    // Recorded from the first script on, before the app can inject anything.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as ViolationWindow).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.effectiveDirective}: ${event.blockedURI} ${event.sample}`.trim());
      });
    });
    const consoleViolations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) consoleViolations.push(message.text());
    });

    const response = await page.goto("/proxies");
    expect(response?.status()).toBe(200);
    const policy = styleSrc(response?.headers()["content-security-policy"]);
    expect(policy).not.toContain("'unsafe-inline'");
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce, "style-src names a per-response nonce").toBeTruthy();
    // The shell hands the app the same nonce the header names.
    await expect
      .poll(() =>
        page.locator('meta[property="csp-nonce"]').evaluate((meta: HTMLMetaElement) => meta.nonce),
      )
      .toBe(nonce);

    // Select: the scroll lock, and the viewport's own <style>.
    const namespace = page.getByRole("combobox", { name: /namespace/i });
    await namespace.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expectScrollLockApplied(page);
    await expect
      .poll(() =>
        page
          .locator("[data-radix-select-viewport]")
          .evaluate((viewport) => getComputedStyle(viewport).scrollbarWidth),
      )
      .toBe("none");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);

    // Dialog: the mobile navigation drawer, behind the same scroll lock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(page.getByRole("dialog", { name: "Main navigation" })).toBeVisible();
    await expectScrollLockApplied(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Main navigation" })).toHaveCount(0);

    expect(
      await page.evaluate(() => (window as ViolationWindow).__cspViolations),
      "no securitypolicyviolation fired",
    ).toEqual([]);
    expect(consoleViolations, "no CSP violation was logged").toEqual([]);
  });
});
