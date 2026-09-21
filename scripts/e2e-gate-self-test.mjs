/* ------------------------------------------------------------------ */
/*  Proof that the release gate is not vacuous (issue #380)            */
/* ------------------------------------------------------------------ */

/**
 * A suite that passes is only evidence if it would have failed.
 *
 * This breaks the critical journey deliberately — the gateway refuses every
 * write the journey needs — and asserts the suite *fails*. A green run here is
 * the failure: it means the journeys are no longer testing what they claim,
 * and releasing on them would be releasing on nothing.
 *
 * It runs against the same stack as the suite and leaves the fault forwarder
 * disarmed however it exits.
 *
 *   FAULT_PROXY_URL=http://127.0.0.1:9500 FAULT_TOKEN=... \
 *   node scripts/e2e-gate-self-test.mjs
 */

import { spawn } from "node:child_process";

const FAULT_URL = process.env.FAULT_PROXY_URL ?? "http://127.0.0.1:9500";
const FAULT_TOKEN = process.env.FAULT_TOKEN ?? "e2e-fault-token";
const JOURNEY = process.env.FERRUM_E2E_SELF_TEST_JOURNEY ?? "e2e/journeys/first-route.spec.ts";

async function fault(method, body) {
  const response = await fetch(`${FAULT_URL}/__fault`, {
    method,
    headers: { "content-type": "application/json", "x-fault-token": FAULT_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`fault control ${method} returned ${response.status}`);
  }
  return response.json();
}

function runPlaywright(args) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "test", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

await fault("DELETE");

// Every write the journey makes is refused, for far longer than it runs.
// The journey's own post-conditions — a resource the gateway holds, a route
// that refuses anonymous callers — cannot be satisfied.
await fault("POST", { method: "POST", path: "/", times: 10_000, status: 503 });
await fault("POST", { method: "PUT", path: "/", times: 10_000, status: 503 });

let result;
try {
  result = await runPlaywright([JOURNEY, "--reporter=line"]);
} finally {
  await fault("DELETE");
}

if (result.code === 0) {
  console.error(result.output);
  console.error(
    "\nThe critical journey PASSED with every gateway write refused.\n" +
      "The gate is vacuous: it would not stop a release that broke this journey.\n" +
      "Find the assertion that stopped depending on the gateway's real state.",
  );
  process.exit(1);
}

console.log(
  `The critical journey failed as it must when the gateway refuses its writes ` +
    `(exit ${result.code}). The gate is live.`,
);
