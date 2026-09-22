/* ------------------------------------------------------------------ */
/*  Proof that the release gate is not vacuous (issue #380)            */
/* ------------------------------------------------------------------ */

/**
 * A suite that passes is only evidence if it would have failed.
 *
 * This breaks one thing in a way the UI cannot see: `POST /consumers` is
 * answered with a fabricated `201` and never reaches the gateway. The browser
 * shows "Consumer created successfully" and the gateway holds nothing. Only a
 * journey that checks the gateway's own state — rather than the page's word —
 * can notice, and the critical journey must.
 *
 * It is not enough for the run to fail. An earlier version refused every
 * write, which killed the suite's global setup before any journey ran; that
 * "proved" the gate was live even with every assertion deleted. So this
 * reads Playwright's JSON report and requires all of:
 *
 *   - the fault was actually triggered;
 *   - global setup succeeded, so the journeys actually ran;
 *   - the steps before the break passed, so the stack was healthy;
 *   - the consumer step failed.
 *
 * It leaves the fault forwarder disarmed however it exits.
 *
 *   FAULT_PROXY_URL=http://127.0.0.1:9500 FAULT_TOKEN=... \
 *   node scripts/e2e-gate-self-test.mjs
 */

import { spawn } from "node:child_process";

const FAULT_URL = process.env.FAULT_PROXY_URL ?? "http://127.0.0.1:9500";
const FAULT_TOKEN = process.env.FAULT_TOKEN ?? "e2e-fault-token";
const JOURNEY = "e2e/journeys/first-route.spec.ts";
const BROKEN_STEP = /generated credential/i;
const HEALTHY_STEPS = [/creates an upstream/i, /creates a proxy/i];

async function fault(method, body) {
  const response = await fetch(`${FAULT_URL}/__fault`, {
    method,
    headers: { "content-type": "application/json", "x-fault-token": FAULT_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fault control ${method} returned ${response.status}`);
  return response.json();
}

function runPlaywright() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "test", JOURNEY, "--reporter=json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FERRUM_E2E_SELF_TEST_FAULT: phantomConsumer },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Flatten the JSON report into `{ title, status }` per test. */
function outcomes(report) {
  const results = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        results.push({ title: spec.title, status: test.results?.at(-1)?.status ?? "skipped" });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return results;
}

function fail(message, detail) {
  if (detail) console.error(detail);
  console.error(`\nGATE SELF-TEST FAILED: ${message}`);
  process.exit(1);
}

await fault("DELETE");
// The UI is told the consumer exists. The gateway never hears about it.
// Armed by the suite's own global setup (FERRUM_E2E_SELF_TEST_FAULT), after
// it disarms the forwarder: armed here, setup would clear it and this would
// be testing an unbroken stack.
const phantomConsumer = JSON.stringify({
  method: "POST",
  path: "/consumers",
  times: 1_000,
  status: 201,
  body: JSON.stringify({
    id: "gate-self-test-phantom",
    username: "gate-self-test-phantom",
    credentials: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }),
});

const blockedBefore = (await fault("GET")).blocked;
let run;
let blockedAfter;
try {
  run = await runPlaywright();
} finally {
  blockedAfter = (await fault("GET")).blocked;
  await fault("DELETE");
}

// The break must actually have happened, or the run proves nothing.
if (!(blockedAfter > blockedBefore)) {
  fail("the phantom-consumer fault was never triggered, so the stack was not broken.");
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  fail("Playwright produced no JSON report.", run.stderr);
}

if ((report.errors ?? []).length > 0) {
  fail(
    "the suite errored outside the journeys (global setup or configuration), so the " +
      "failure proves nothing about the journeys themselves.",
    JSON.stringify(report.errors, null, 2),
  );
}

const results = outcomes(report);
for (const healthy of HEALTHY_STEPS) {
  const step = results.find((result) => healthy.test(result.title));
  if (!step || step.status !== "passed") {
    fail(`the step before the break (${healthy}) did not pass, so the stack was not healthy.`, JSON.stringify(results, null, 2));
  }
}

const broken = results.find((result) => BROKEN_STEP.test(result.title));
if (!broken) fail("the consumer step did not run.", JSON.stringify(results, null, 2));
if (broken.status === "passed") {
  fail(
    "the consumer step PASSED while the gateway never received the consumer. It is " +
      "trusting the UI's success message instead of reading the gateway back.",
    JSON.stringify(results, null, 2),
  );
}
if (run.code === 0) fail("Playwright exited 0 with a failing step.");

console.log(
  "The gate is live: with the consumer write silently dropped, the journey's " +
    "gateway read-back failed the consumer step, after setup and the preceding " +
    "steps had passed.",
);
