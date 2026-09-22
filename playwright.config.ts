import { defineConfig, devices } from "@playwright/test";

/**
 * Critical-journey suite (issue #380).
 *
 * These tests drive a real browser against a production-built Foundry SPA and
 * BFF, behind the documented identity-aware proxy, in front of a pinned real
 * Ferrum Edge gateway and a disposable data-plane backend. They are the layer
 * the unit, contract, and container gates do not join up.
 *
 * The stack is not started here. It is the checked-in starter in
 * `deploy/starter/` plus the fault proxy — see `e2e/README.md`. Owning the
 * stack from a Playwright global setup would make the suite something other
 * than a test of the shipped deployment.
 *
 *   npm run e2e            against an already-running stack
 *   npm run e2e:report     open the last HTML report
 */

const FOUNDRY_URL = process.env.FOUNDRY_URL ?? "http://127.0.0.1:8088";

export default defineConfig({
  testDir: "./e2e/journeys",
  globalSetup: "./e2e/support/global-setup.ts",
  // A release gate must not be able to pass by repetition. A journey that
  // needs a retry to go green is a journey that is telling us something.
  retries: 0,
  // One worker: the journeys share one gateway namespace and arm faults on a
  // shared forwarder, so running them concurrently would make each one's
  // failures somebody else's flake.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "e2e-report", open: "never" }], ["github"]]
    : [["list"], ["html", { outputFolder: "e2e-report", open: "never" }]],
  outputDir: "e2e-results",
  use: {
    baseURL: FOUNDRY_URL,
    // Evidence, and only on failure: a trace, the screen, and the video. The
    // journeys never type a real credential, and the demo secrets are
    // generated per run, so nothing long-lived is captured.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // One explicitly supported browser to start with, as the issue scopes.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
