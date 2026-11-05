/* ------------------------------------------------------------------ */
/*  "Outcome unknown, do not replay" latches                           */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { acmeOrderInProgress, type AcmeOrder } from "@/api/tls";
import type { UnobservedOutcome } from "@/api/mutationOutcome";

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
 * - A restore has no operation id to read back either, so the same holds. The
 *   latch keeps only what the warning shows, never the backup itself: the
 *   payload carries credentials and is not retained past its card.
 */
export type OutcomeLatch =
  | { kind: "acme_order_creation"; message: string; orderId: string }
  | { kind: "acme_renewal"; certificateId: string; orderId: string }
  | { kind: "acme_finalization"; orderId: string }
  | { kind: "api_spec_write"; namespace: string; message: string }
  | {
      kind: "restore";
      namespace: string;
      fileName: string;
      outcome: UnobservedOutcome;
      confirmedApiSpecDeletion: boolean;
    };

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
  // An unknown restore outcome, and a restore in flight, per namespace.
  restore: (namespace: string) => `restore:${namespace}`,
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
    case "restore":
      return latchKeys.restore(latch.namespace);
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
    case "restore":
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
  // A copy, so each installation is its own identity (see `releaseOutcomeLatch`).
  publish(new Map(latches).set(latchKey(latch), { ...latch }));
}

/**
 * How long to wait before re-reading an order a latched create or renew
 * named, after each read that did not find it. Edge persists the order only
 * after its CA round-trip, so an early read can miss it. Mutable for tests.
 */
export const ORDER_PROBE_DELAYS_MS: number[] = [5_000, 20_000, 60_000];

/**
 * End one latch because the operator, having checked the gateway, chose to
 * allow the action again. `reviewed` is the latch the operator was shown:
 * every `latchOutcome` stores a new object, so if another unanswered write
 * replaced it meanwhile, nothing is released and the newer latch must be
 * reviewed in turn.
 */
export function releaseOutcomeLatch(key: string, reviewed: OutcomeLatch): boolean {
  if (latches.get(key) !== reviewed) return false;
  const next = new Map(latches);
  next.delete(key);
  publish(next);
  return true;
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

/*
 * Writes in flight, by the same keys. A component's own mutation observer
 * forgets its request when the component unmounts (a tab switch, leaving the
 * route, a namespace switch), but the request keeps running, and its answer
 * may still install a latch. So "may another such write start, or may a
 * latch be re-armed" is answered here, for as long as the request runs.
 */
let inFlight: ReadonlyMap<string, number> = new Map();

function publishInFlight(next: ReadonlyMap<string, number>): void {
  inFlight = next;
  for (const listener of listeners) listener();
}

/**
 * Record a write as dispatched. The returned release, called from a `finally`
 * that runs whatever became of the component, ends it; extra calls are no-ops.
 */
export function beginWrite(key: string): () => void {
  publishInFlight(new Map(inFlight).set(key, (inFlight.get(key) ?? 0) + 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = new Map(inFlight);
    const count = (next.get(key) ?? 1) - 1;
    if (count > 0) next.set(key, count);
    else next.delete(key);
    publishInFlight(next);
  };
}

export function isWriteInFlight(key: string): boolean {
  return (inFlight.get(key) ?? 0) > 0;
}

function inFlightSnapshot(): ReadonlyMap<string, number> {
  return inFlight;
}

/** Writes in flight by key, for rendering; handlers read `isWriteInFlight`. */
export function useWritesInFlight(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, inFlightSnapshot);
}

/** Test-only reset. */
export function clearOutcomeLatches(): void {
  inFlight = new Map();
  publish(new Map());
}
