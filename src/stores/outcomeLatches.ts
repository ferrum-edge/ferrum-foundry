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
 *   Edge's `content_hash`. A replace settles when its target spec is read
 *   holding that hash, unless the target already held it before the request
 *   (as the cached summary or the document the Replace dialog read): an
 *   unchanged resubmission cannot be told apart from what was already
 *   stored, so it stays latched. An import settles on a spec
 *   holding that hash that a complete read before the request did not list;
 *   after only a partial read, an existing spec on an unread page could hold
 *   the same document, so nothing settles it. Without Web Crypto
 *   (`contentHash: null`) neither settles before a reload.
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
      /**
       * Every spec id a complete read listed before the document was sent, or
       * `null` when no complete read preceded it.
       */
      knownIds: readonly string[] | null;
    }
  | {
      kind: "api_spec_replace";
      namespace: string;
      message: string;
      specId: string;
      contentHash: string | null;
      /**
       * The target's content hashes read before the document was sent (the
       * cached summary and the Replace dialog's fresh document read), or
       * `null` when there was no fresh read.
       */
      priorHashes: readonly string[] | null;
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
      const known = latch.knownIds;
      return (
        latch.contentHash !== null &&
        known !== null &&
        seen?.namespace === latch.namespace &&
        seen.specs.some((spec) => spec.content_hash === latch.contentHash && !known.includes(spec.id))
      );
    }
    case "api_spec_replace": {
      const seen = observation.apiSpecs;
      const sent = latch.contentHash;
      return (
        sent !== null &&
        latch.priorHashes !== null &&
        !latch.priorHashes.includes(sent) &&
        seen?.namespace === latch.namespace &&
        seen.specs.some((spec) => spec.id === latch.specId && spec.content_hash === sent)
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
