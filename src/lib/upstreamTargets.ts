/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – upstream target row identity and action names     */
/* ------------------------------------------------------------------ */

import type { UpstreamTarget } from "@/api/types";

/** `host:port`, as a target row displays it. */
export function targetAddress(target: Pick<UpstreamTarget, "host" | "port">): string {
  return `${target.host}:${target.port}`;
}

/**
 * A stable identity for each target in `targets`: its address plus how many
 * earlier targets share that address. Removing or inserting a target with a
 * different address leaves every other identity unchanged, so a row keyed on
 * it — and an open editor bound to it — follows its own target when rows
 * shift, instead of staying on a position another target now occupies.
 */
export function targetIdentities(targets: readonly UpstreamTarget[]): string[] {
  const seen = new Map<string, number>();
  return targets.map((target) => {
    const address = targetAddress(target);
    const occurrence = seen.get(address) ?? 0;
    seen.set(address, occurrence + 1);
    return `${address}#${occurrence}`;
  });
}

/**
 * Accessible names for a target row's icon-only actions, naming the target
 * they act on. A repeated address is numbered so each name stays unique.
 */
export function targetActionLabels(
  targets: readonly UpstreamTarget[],
  index: number,
): { edit: string; remove: string } {
  const address = targetAddress(targets[index]);
  const same = targets.filter((target) => targetAddress(target) === address).length;
  const occurrence = targets
    .slice(0, index)
    .filter((target) => targetAddress(target) === address).length;
  const name = same > 1 ? `${address} (${occurrence + 1} of ${same})` : address;
  return { edit: `Edit target ${name}`, remove: `Remove target ${name}` };
}
