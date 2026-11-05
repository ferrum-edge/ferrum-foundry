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
 * route re-arms the action. A latch ends only when the gateway shows the
 * outcome (`settledBy`), or with the page itself. Each `createdAfter` is a
 * gateway timestamp floor taken before the request was sent, so a record the
 * gateway created later can only be this request's (or a concurrent one's)
 * work, never an older record from an unread page. `null` means no floor
 * could be established and the latch never settles by observation.
 */
export type OutcomeLatch =
  | {
      kind: "acme_order_creation";
      message: string;
      /** The requested domain set, normalized by `domainSet`. */
      domains: string;
      createdAfter: number | null;
    }
  | { kind: "acme_renewal"; certificateId: string; createdAfter: number | null }
  | { kind: "acme_finalization"; orderId: string }
  | { kind: "api_spec_import"; namespace: string; message: string; createdAfter: number | null }
  | {
      kind: "api_spec_replace";
      namespace: string;
      message: string;
      specId: string;
      contentHash: string;
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

export function domainSet(domains: readonly string[]): string {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].sort().join(",");
}

function createdAfter(record: { created_at: string }, floor: number | null): boolean {
  if (floor === null) return false;
  const created = Date.parse(record.created_at);
  return Number.isFinite(created) && created > floor;
}

/**
 * The gateway-clock floor for a request about to be sent: the newest
 * timestamp among the records already read. A collection read as empty gives
 * no records to compare, so every later record is new (`-Infinity`); a
 * collection never read gives no floor at all (`null`).
 */
export function timestampFloor(
  records: readonly { created_at: string; updated_at: string }[],
  collectionEmpty: boolean,
): number | null {
  let floor: number | null = collectionEmpty ? Number.NEGATIVE_INFINITY : null;
  for (const record of records) {
    for (const stamp of [record.created_at, record.updated_at]) {
      const value = Date.parse(stamp);
      if (Number.isFinite(value)) floor = Math.max(floor ?? value, value);
    }
  }
  return floor;
}

/** Whether an observation shows the outcome the latch was waiting for. */
export function settledBy(latch: OutcomeLatch, observation: LatchObservation): boolean {
  switch (latch.kind) {
    case "acme_order_creation":
      return (observation.acmeOrders ?? []).some(
        (order) =>
          domainSet(order.domains) === latch.domains && createdAfter(order, latch.createdAfter),
      );
    case "acme_renewal":
      return (observation.acmeOrders ?? []).some(
        (order) =>
          order.certificate_id === latch.certificateId && createdAfter(order, latch.createdAfter),
      );
    case "acme_finalization":
      return (observation.acmeOrders ?? []).some(
        (order) => order.id === latch.orderId && !acmeOrderInProgress(order),
      );
    case "api_spec_import": {
      const seen = observation.apiSpecs;
      return (
        seen?.namespace === latch.namespace &&
        seen.specs.some((spec) => createdAfter(spec, latch.createdAfter))
      );
    }
    case "api_spec_replace": {
      const seen = observation.apiSpecs;
      return (
        seen?.namespace === latch.namespace &&
        seen.specs.some(
          (spec) =>
            spec.id === latch.specId &&
            (spec.content_hash !== latch.contentHash || spec.updated_at !== latch.updatedAt),
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
