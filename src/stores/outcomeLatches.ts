/* ------------------------------------------------------------------ */
/*  "Outcome unknown, do not replay" latches                           */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { acmeOrderInProgress, type AcmeOrder } from "@/api/tls";
import type { ApiSpecSummary } from "@/api/apiSpecs";

/**
 * A mutation whose answer Foundry never observed (`MutationOutcomeUnknownError`
 * or `AcmeFinalizationUnknownError`). It may have committed, so the action
 * stays disarmed: it must never be one click from running again.
 *
 * Latches live in this module, not in the component that issued the request,
 * so neither a tab switch (Radix unmounts inactive panels) nor leaving the
 * route re-arms the action. A latch ends only when a read shows *this
 * request's* outcome (`settledBy`), or with the page itself. Proof is a
 * correlation the request itself carried, never a timestamp boundary inferred
 * from whichever records happened to be read: Edge lists ACME orders in id
 * order and API specs unsorted, so a record on an unread page says nothing
 * about when it was created relative to this request.
 *
 * - ACME creation and renewal send a Foundry-chosen order `id`; only an order
 *   with that id settles them. Edge refuses a second order with the same id.
 * - API spec writes record the SHA-256 of the exact document sent, which is
 *   Edge's `content_hash`. An import settles on a spec with that hash that
 *   was not already known to hold it; a replace settles when its target spec
 *   is read holding that hash at a new `updated_at`. Without Web Crypto
 *   (`contentHash: null`) nothing settles them before a reload.
 */
export type OutcomeLatch =
  | { kind: "acme_order_creation"; message: string; orderId: string }
  | { kind: "acme_renewal"; certificateId: string; orderId: string }
  | { kind: "acme_finalization"; orderId: string }
  | {
      kind: "api_spec_import";
      namespace: string;
      message: string;
      contentHash: string | null;
      /** Specs already read holding that document before it was sent. */
      knownIds: readonly string[];
    }
  | {
      kind: "api_spec_replace";
      namespace: string;
      message: string;
      specId: string;
      contentHash: string | null;
      /** The target's `updated_at` as read before the document was sent. */
      updatedAt: string;
    };

/** What the gateway has been seen to hold, from any read. */
export interface LatchObservation {
  acmeOrders?: readonly AcmeOrder[];
  apiSpecs?: { namespace: string; specs: readonly ApiSpecSummary[] };
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
    case "api_spec_import":
    case "api_spec_replace":
      return latchKeys.apiSpecWrite(latch.namespace);
    default:
      return assertNever(latch);
  }
}

/**
 * The lowercase hex SHA-256 of a document's UTF-8 bytes, which is what Edge
 * stores as an API spec's `content_hash`; `null` where Web Crypto is not
 * available (an insecure context).
 */
export async function documentHash(document: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(document));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
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
    case "api_spec_import": {
      const seen = observation.apiSpecs;
      return (
        latch.contentHash !== null &&
        seen?.namespace === latch.namespace &&
        seen.specs.some(
          (spec) => spec.content_hash === latch.contentHash && !latch.knownIds.includes(spec.id),
        )
      );
    }
    case "api_spec_replace": {
      const seen = observation.apiSpecs;
      return (
        latch.contentHash !== null &&
        seen?.namespace === latch.namespace &&
        seen.specs.some(
          (spec) =>
            spec.id === latch.specId &&
            spec.content_hash === latch.contentHash &&
            spec.updated_at !== latch.updatedAt,
        )
      );
    }
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

function snapshot(): ReadonlyMap<string, OutcomeLatch> {
  return latches;
}

export function latchOutcome(latch: OutcomeLatch): void {
  publish(new Map(latches).set(latchKey(latch), latch));
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
  return useSyncExternalStore(subscribe, snapshot);
}

/** Test-only reset. */
export function clearOutcomeLatches(): void {
  publish(new Map());
}
