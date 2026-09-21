/* ------------------------------------------------------------------ */
/*  Critical-journey preconditions (issue #380)                        */
/* ------------------------------------------------------------------ */

import { GatewayClient, NAMESPACE, NAMESPACE_B, FAULT_URL, FAULT_TOKEN } from "./stack";

/**
 * Register the two namespaces the journeys use and hand the fault forwarder
 * back disarmed.
 *
 * `GET /namespaces` is the union of the durable registry and namespaces
 * derived from resource rows, so a namespace with no resources yet would not
 * appear in the switcher at all. Registering both makes the switch the
 * journeys perform deterministic rather than dependent on what a previous run
 * happened to leave behind.
 *
 * This fails loudly. A suite that quietly runs against an unprepared stack is
 * a suite whose green is meaningless.
 */
export default async function globalSetup(): Promise<void> {
  for (const namespace of [NAMESPACE, NAMESPACE_B]) {
    const gateway = new GatewayClient("admin", namespace);
    await gateway.session();
    const created = await gateway.send<{ error?: string }>("POST", "/namespaces", {
      name: namespace,
      description: "critical journey suite",
    });
    // 409 means it is already registered, which is the state we want.
    if (![200, 201, 409].includes(created.status)) {
      throw new Error(
        `Could not register namespace ${namespace}: ${created.status} ` +
          `${JSON.stringify(created.body)}`,
      );
    }
  }

  const disarmed = await fetch(`${FAULT_URL}/__fault`, {
    method: "DELETE",
    headers: { "x-fault-token": FAULT_TOKEN },
  });
  if (!disarmed.ok) {
    throw new Error(
      `The fault forwarder at ${FAULT_URL} did not answer (${disarmed.status}). ` +
        "Start it with `node e2e/fault-proxy.mjs` — the failure-injection " +
        "journeys cannot run without it, and skipping them silently would " +
        "make this gate weaker than it looks.",
    );
  }
}
