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
 * Where a target identity lands after the target `removed` (an identity in the
 * same list) is taken out: an earlier target with the same address no longer
 * counts toward its occurrence. Any other identity is unchanged.
 */
export function identityAfterRemoval(identity: string, removed: string): string {
  const split = (value: string) => {
    const at = value.lastIndexOf("#");
    return { address: value.slice(0, at), occurrence: Number(value.slice(at + 1)) };
  };
  const target = split(identity);
  const gone = split(removed);
  if (target.address !== gone.address || gone.occurrence >= target.occurrence) return identity;
  return `${target.address}#${target.occurrence - 1}`;
}

/**
 * `targets` with each target's optional members spelled out: `path` and
 * `locality` absent or `null`, and `tags` absent or `{}`, mean the same thing
 * to the gateway, so a read that omits them still holds the list a write sent.
 * Every other difference — a changed value, an added member, a reordered
 * target — survives, so two lists whose normalized forms fingerprint the same
 * are the same list.
 *
 * Like `resourceBaseline.ts`, this module has only type imports:
 * `scripts/gateway-contract-smoke.mjs` loads it directly to check the pinned
 * gateway reads a written list back in a form this accepts.
 */
export function normalizedTargets(targets: readonly UpstreamTarget[]): UpstreamTarget[] {
  return targets.map((target) => ({
    ...target,
    path: target.path ?? null,
    locality: target.locality ?? null,
    tags: target.tags ?? {},
  }));
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
