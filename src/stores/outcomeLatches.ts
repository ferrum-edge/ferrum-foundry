/* ------------------------------------------------------------------ */
/*  "Outcome unknown, do not replay" latches                           */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { acmeOrderInProgress, type AcmeOrder } from "@/api/tls";

/**
 * A mutation whose answer Foundry never observed (`MutationOutcomeUnknownError`
 * or `AcmeFinalizationUnknownError`). It may have committed, so the action
 * stays disarmed: it must never be one click from running again.
 *
 * Latches live in this module, not in the component that issued the request,
 * so neither a tab switch (Radix unmounts inactive panels) nor leaving the
 * route re-arms the action. A latch ends only on proof that the request
 * itself carried (`settledBy`), on an operator's deliberate re-arm
 * (`releaseOutcomeLatch`), or with the page itself. A timestamp, or content
 * that happens to match, is never proof: a record on an unread or older read
 * page says nothing about this request.
 *
 * - ACME creation and renewal send a Foundry-chosen order `id`; only an order
 *   with that id settles them. Edge refuses a second order with the same id.
 * - ACME finalization settles when its order is read in a terminal state.
 * - An API spec import or replace carries nothing a read can correlate with:
 *   Edge generates the spec id, and a document hash identifies content, not an
 *   operation. So no read settles it; the operator re-arms it after checking
 *   the gateway, or reloads.
 */
export type OutcomeLatch =
  | { kind: "acme_order_creation"; message: string; orderId: string }
  | { kind: "acme_renewal"; certificateId: string; orderId: string }
  | { kind: "acme_finalization"; orderId: string }
  | { kind: "api_spec_write"; namespace: string; message: string };

/** What the gateway has been seen to hold, from any read. */
export interface LatchObservation {
  acmeOrders?: readonly AcmeOrder[];
}

export const latchKeys = {
  acmeOrderCreation: () => "acme:order-creation",
  acmeRenewal: (certificateId: string) => `acme:renewal:${certificateId}`,
  acmeFinalization: (orderId: string) => `acme:finalization:${orderId}`,
  // One latch per namespace: an uncertain import or replace disarms every
  // spec write in that namespace, as the page always has.
  apiSpecWrite: (namespace: string) => `api-spec:${namespace}`,
};

function assertNever(value: never): never {
  throw new Error(`Unhandled outcome latch: ${JSON.stringify(value)}`);
}

function latchKey(latch: OutcomeLatch): string {
  switch (latch.kind) {
    case "acme_order_creation":
      return latchKeys.acmeOrderCreation();
    case "acme_renewal":
      return latchKeys.acmeRenewal(latch.certificateId);
    case "acme_finalization":
      return latchKeys.acmeFinalization(latch.orderId);
    case "api_spec_write":
      return latchKeys.apiSpecWrite(latch.namespace);
    default:
      return assertNever(latch);
  }
}

/**
 * A random RFC 4122 version-4 id for a request that must be recognizable in a
 * later read. `crypto.randomUUID` needs a secure context; `getRandomValues`
 * does not, so it is the fallback. Throws only where the browser has no Web
 * Crypto at all, before anything is sent.
 */
export function correlationId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether an observation shows the outcome the latch was waiting for. */
export function settledBy(latch: OutcomeLatch, observation: LatchObservation): boolean {
  switch (latch.kind) {
    case "acme_order_creation":
    case "acme_renewal":
      return (observation.acmeOrders ?? []).some((order) => order.id === latch.orderId);
    case "acme_finalization":
      return (observation.acmeOrders ?? []).some(
        (order) => order.id === latch.orderId && !acmeOrderInProgress(order),
      );
    case "api_spec_write":
      // No read can prove what this request did; only a deliberate re-arm ends it.
      return false;
    default:
      return assertNever(latch);
  }
}

let latches: ReadonlyMap<string, OutcomeLatch> = new Map();
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, OutcomeLatch>): void {
  latches = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current latches, keyed by `latchKeys`. */
export function getOutcomeLatches(): ReadonlyMap<string, OutcomeLatch> {
  return latches;
}

export function latchOutcome(latch: OutcomeLatch): void {
  publish(new Map(latches).set(latchKey(latch), latch));
}

/**
 * End one latch because the operator, having checked the gateway, chose to
 * allow the action again.
 */
export function releaseOutcomeLatch(key: string): void {
  if (!latches.has(key)) return;
  const next = new Map(latches);
  next.delete(key);
  publish(next);
}

/** End every latch the observation settles. */
export function settleOutcomeLatches(observation: LatchObservation): void {
  const next = new Map(latches);
  for (const [key, latch] of latches) {
    if (settledBy(latch, observation)) next.delete(key);
  }
  if (next.size !== latches.size) publish(next);
}

export function useOutcomeLatches(): ReadonlyMap<string, OutcomeLatch> {
  return useSyncExternalStore(subscribe, getOutcomeLatches);
}

/** Test-only reset. */
export function clearOutcomeLatches(): void {
  publish(new Map());
}
