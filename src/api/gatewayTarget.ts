/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – gateway target binding                            */
/* ------------------------------------------------------------------ */

import { clearGatewayMetadata } from "./gatewayMetadata";

/**
 * Gateway target rule
 * -------------------
 * The BFF names the gateway it resolves requests against in
 * `X-Foundry-Gateway-Target` on every session, settings, and proxy response
 * (`server/gateway-target.ts`). The namespace header cannot tell the same
 * namespace on two gateways apart, and query keys, editor identities, and
 * capability observations carry no gateway at all, so a page load belongs to
 * exactly one target:
 *
 * 1. **Bind once.** The first target the BFF names is this page's target for
 *    its whole lifetime. Every later gateway-facing request declares it, and
 *    the BFF refuses one it no longer resolves to (`409`
 *    `FERRUM_BFF_GATEWAY_TARGET_CHANGED`) before signing or forwarding it —
 *    so the next page of a listing, a membership plan's apply, a follow-up
 *    poll, or a draft submitted from an idle tab can never reach a
 *    replacement gateway, whichever tab re-pointed the BFF.
 *
 * 2. **Retire, never adopt.** Any other target observed — this tab's own
 *    settings save, the periodic session check, or that refusal — retires
 *    the workspace: the client sends no further gateway request, live-apply
 *    monitoring is dropped (so a late answer from the old gateway cannot
 *    repopulate it), and `GatewayTargetGate` discards cached reads and
 *    unmounts every editor, confirmation, and capability observation in
 *    favour of an explicit reload state. A reload binds the new target with
 *    nothing carried across.
 *
 * Ordinary refreshes that name the same target change nothing, so drafts
 * survive them. See `docs/authentication.md` → "Gateway target binding".
 */
export const GATEWAY_TARGET_HEADER = "X-Foundry-Gateway-Target";
export const GATEWAY_TARGET_CHANGED_CODE = "FERRUM_BFF_GATEWAY_TARGET_CHANGED";

export const GATEWAY_TARGET_CHANGED_MESSAGE =
  "Foundry is now connected to a different Ferrum Edge gateway. Nothing from " +
  "the previous gateway was sent to it. Reload to open a fresh workspace.";

/** Thrown for a gateway request issued after this page's target was retired. */
export class GatewayTargetChangedError extends Error {
  constructor(url: string) {
    super(`Refused ${url}: the gateway target this page was opened against was replaced`);
    this.name = "GatewayTargetChangedError";
  }
}

let bound: string | null = null;
let retired = false;
const listeners = new Set<() => void>();

/** The target every gateway-facing request declares, once one is known. */
export function boundGatewayTarget(): string | null {
  return bound;
}

export function isGatewayTargetRetired(): boolean {
  return retired;
}

export function subscribeGatewayTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** BFF routes whose answer depends on the configured gateway target. */
export function targetsGateway(url: string): boolean {
  const path = new URL(url, "http://localhost").pathname;
  return path.startsWith("/api/proxy/") || path === "/api/settings" || path.startsWith("/api/settings/");
}

/**
 * Record the target a BFF response names. The first one binds this page; a
 * different one retires it. A response that names none says nothing.
 */
export function observeGatewayTarget(target: string | null | undefined): void {
  if (!target || retired) return;
  if (bound === null) {
    bound = target;
    return;
  }
  if (target !== bound) retireGatewayTarget();
}

/** Stop this page from acting on, or presenting, its original gateway target. */
export function retireGatewayTarget(): void {
  if (retired) return;
  retired = true;
  clearGatewayMetadata();
  for (const listener of listeners) listener();
}

/** Test-only reset of the page binding. */
export function resetGatewayTarget(): void {
  bound = null;
  retired = false;
  for (const listener of listeners) listener();
}
