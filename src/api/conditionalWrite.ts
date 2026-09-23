/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – guarded full-replacement writes                   */
/* ------------------------------------------------------------------ */

import { isHTTPError } from "ky";
import {
  HANDLED_STATUSES,
  proxyApi,
  scoped,
  SILENT_ERRORS,
  type NamespaceScope,
} from "./client";
import {
  resourceFingerprint,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";

/** What the refused request would have done. */
export type GuardedOperation = "save" | "delete";

/**
 * The three sides an operator needs to resolve a concurrent-edit conflict.
 * Values are rendered through `formatBaselineValue`, which redacts
 * credential-shaped fields; nothing here is written to browser storage.
 */
export interface StaleResourceDetail {
  /** Human-readable resource kind, e.g. `"proxy"`. */
  readonly resource: string;
  /**
   * A refused save leaves a draft to keep or discard. A refused delete leaves
   * the resource in place, and `proposed` is the baseline itself: there is no
   * draft value for any field.
   */
  readonly operation: GuardedOperation;
  readonly id: string;
  /** The namespace the refused write was bound to. */
  readonly namespace: string;
  /** The content the editor was opened against. */
  readonly original: BaselineSnapshot;
  /** The content the gateway holds now. */
  readonly current: BaselineSnapshot;
  /** The content this editor was about to write (the baseline for a delete). */
  readonly proposed: BaselineSnapshot;
}

/**
 * Raised instead of committing a full-replacement write whose baseline no
 * longer matches the gateway — either because the verification read already
 * differed, or because the gateway refused the conditional `PUT` with `412`
 * and the re-read did. It is also raised after `PRECONDITION_ATTEMPTS`
 * consecutive `412`s whose re-reads all matched: then `current` equals
 * `original` on every compared field, and the dialog says the change is in a
 * field the comparison does not model. Nothing from the draft was written, and the draft
 * itself is untouched: the caller keeps the form mounted and the operator
 * decides what happens next. A refused delete deleted nothing.
 *
 * This is never retried automatically. Re-sending the same body against a
 * fresh read is exactly the silent overwrite the guard exists to prevent.
 */
export class StaleResourceError extends Error {
  readonly detail: StaleResourceDetail;

  constructor(detail: StaleResourceDetail) {
    super(
      `This ${detail.resource} changed on the gateway since you opened it. ` +
        (detail.operation === "delete"
          ? "It was not deleted."
          : "Your draft was not saved."),
    );
    this.name = "StaleResourceError";
    this.detail = detail;
  }
}

export function isStaleResourceError(error: unknown): error is StaleResourceError {
  return error instanceof StaleResourceError;
}

/**
 * What an editor captured when it opened, plus how to reduce a resource or a
 * write payload of this kind to the comparable content.
 *
 * `select` decides what the write can lose. A whole-resource form selects the
 * full writable field set; a single-field write such as the upstream targets
 * editor selects only that field, so this same operator saving the settings
 * tab is not mistaken for a competing writer.
 */
export interface WriteGuard<TShape> {
  readonly baseline: BaselineSnapshot;
  readonly select: (value: TShape) => BaselineSnapshot;
}

/**
 * A guard that compares nothing, for a write that owns only the fields it
 * sends and takes every other field from the read it is sent against — an
 * unguarded upstream targets write, or a consumer metadata write's
 * credentials. Such a write still goes out conditionally on that read.
 */
export function uncomparedGuard<TShape>(): WriteGuard<TShape> {
  return { baseline: {}, select: () => ({}) };
}

/** A resource read together with the gateway's validator for exactly that read. */
export interface TaggedRead<TResource> {
  readonly value: TResource;
  /**
   * The strong `ETag` the gateway returned, or `null` when it returned none —
   * a gateway without the conditional-write contract, a mode without a
   * database, or the cached-config fallback (`X-Data-Source: cached`), which
   * may lag the database and so is deliberately untagged.
   */
  readonly etag: string | null;
}

/**
 * RFC 9110 strong entity-tag: `DQUOTE *etagc DQUOTE`, with
 * `etagc = %x21 / %x23-7E / obs-text`.
 */
const STRONG_ETAG = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

/**
 * The `ETag` response header as a value that can be sent back in `If-Match`,
 * or `null` when there is nothing usable.
 *
 * Edge compares `If-Match` strongly, so a weak `W/"…"` tag — which only an
 * intermediary would produce here — can never match. Sending one would turn
 * every save into a `412`, so it is treated as no tag at all and the write
 * falls back to the verification read alone.
 */
export function strongEtag(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim();
  return STRONG_ETAG.test(value) ? value : null;
}

// The validator each tagged read was issued with, keyed by the exact object
// that read produced. A copy or a later read of the same resource is a
// different object and carries no validator.
const validators = new WeakMap<object, string>();

/**
 * The strong `ETag` the gateway issued with this exact read, or `null`.
 *
 * For a multi-request operation that reads a resource and then writes it —
 * a plugin membership plan's preflight read followed by its association
 * `PUT`, a delete plan's final existence check followed by its `DELETE` —
 * passing the read's own object here makes the write conditional on it.
 *
 * Never pass an editor's seed or a Query-cache value: those reads may be
 * minutes old, and a tag taken from them would let a draft through against
 * content nobody compared. Editors go through `guardedReplace`, which reads
 * and compares first.
 */
export function validatorOf(value: object | null | undefined): string | null {
  return value ? (validators.get(value) ?? null) : null;
}

/** `GET` one resource and keep the validator the gateway issued for it. */
export async function readTagged<TResource>(
  scope: NamespaceScope,
  path: string,
  options: { readonly silentErrors?: boolean } = {},
): Promise<TaggedRead<TResource>> {
  const response = await proxyApi.get(
    path,
    scoped(scope, {
      headers: { Accept: "application/json" },
      ...(options.silentErrors && { context: { [SILENT_ERRORS]: true } }),
    }),
  );
  const value = await response.json<TResource>();
  const etag = strongEtag(response.headers.get("etag"));
  if (etag !== null && typeof value === "object" && value !== null) {
    validators.set(value, etag);
  }
  return { value, etag };
}

function conditionalOptions(ifMatch: string | null) {
  return ifMatch === null
    ? {}
    : {
        headers: { "If-Match": ifMatch },
        context: { [HANDLED_STATUSES]: [412] },
      };
}

/**
 * Full-replacement `PUT`, conditional on `ifMatch` when there is one.
 *
 * A conditional write's `412` is an outcome `guardedReplace` resolves itself,
 * so it is kept out of the global error popup; every other failure is not.
 * `If-Match` is only ever sent to the resource paths whose `PUT` evaluates it
 * — Edge answers `400` to one on any other mutating route.
 */
export function conditionalPut<TResource>(
  scope: NamespaceScope,
  path: string,
  body: unknown,
  ifMatch: string | null,
): Promise<TResource> {
  return proxyApi
    .put(path, scoped(scope, { json: body, ...conditionalOptions(ifMatch) }))
    .json<TResource>();
}

/** `DELETE`, conditional on `ifMatch` when there is one; see `conditionalPut`. */
export async function conditionalDelete(
  scope: NamespaceScope,
  path: string,
  ifMatch: string | null,
): Promise<void> {
  await proxyApi.delete(path, scoped(scope, conditionalOptions(ifMatch)));
}

/** Whether `error` is the gateway refusing a conditional write. */
export function isPreconditionFailed(error: unknown): boolean {
  return isHTTPError(error) && error.response.status === 412;
}

/**
 * How many times a write whose only `412`s were caused by fields it does not
 * replace is attempted before it is refused anyway. Each attempt is a complete
 * verify-then-write; the bound only stops a resource under continuous churn
 * from holding a save open indefinitely.
 */
export const PRECONDITION_ATTEMPTS = 3;

export interface GuardedReplaceOptions<TResource, TPayload> {
  /** Resource kind, used in the conflict message and dialog heading. */
  readonly resource: string;
  readonly id: string;
  readonly namespace: string;
  readonly guard: WriteGuard<TResource | TPayload>;
  /** A fresh authoritative read, bound to the same namespace as the write. */
  readonly read: () => Promise<TaggedRead<TResource>>;
  /**
   * The body this editor wants to send, given the read it will be sent
   * against. A whole-resource form ignores `current`; the targets editor takes
   * every setting it does not own from it.
   */
  readonly propose: (current: TResource) => TPayload;
  /**
   * The full-replacement `PUT`. When `ifMatch` is not `null` it must be sent
   * as `If-Match`, and a `412` must reach this function's caller as an
   * `HTTPError` (see `HANDLED_STATUSES` in `client.ts`).
   */
  readonly write: (payload: TPayload, ifMatch: string | null) => Promise<TResource>;
}

/**
 * Verify that nobody else has changed a resource since an editor opened it,
 * then perform the full-replacement write conditionally on that verification.
 *
 * ## How the comparison becomes atomic
 *
 * The verification read compares the gateway's current content against the
 * editor's baseline. When the gateway tags that read with an `ETag`, the `PUT`
 * carries it as `If-Match`, and Ferrum Edge refuses the write with `412`
 * unless the stored resource is still exactly the representation that was
 * verified. The two checks compose: the baseline proves the verified read
 * holds nothing this draft would revert, and `If-Match` proves nothing has
 * been written since that read. Edge evaluates the precondition under the
 * same admission lease its every admin writer takes, so no writer — another
 * Foundry deployment, the seeding scripts, Terraform, a direct admin-API
 * client, another control-plane replica — can commit in between.
 *
 * The tag is always taken from the read that was just verified, never from
 * the editor's original load or a later cache refetch. Adopting a tag from
 * any other read would let an older draft pass the precondition against
 * content the operator never compared.
 *
 * ## After a `412`
 *
 * The tag covers the whole stored resource, including fields this write does
 * not replace — a proxy's plugin associations, an upstream's settings during a
 * targets save. So a `412` means "something moved", not "this draft conflicts".
 * The guard re-reads and verifies again from the top:
 *
 * - a change to anything this draft would overwrite fails verification and
 *   raises `StaleResourceError` with the content that caused it;
 * - a change only to fields this draft leaves alone passes verification, and
 *   the write is re-sent against the fresh tag with `propose` re-evaluated on
 *   the fresh read. That is not a replay of a refused write: it is the same
 *   decision the guard would have made had the operator pressed Save a moment
 *   later, and it cannot revert anything.
 *
 * After `PRECONDITION_ATTEMPTS` such rounds the write is refused anyway.
 *
 * ## Without a tag
 *
 * A gateway that returns no `ETag` — one predating the contract, or a read
 * served from the cached-config fallback — gets an unconditional `PUT`. The
 * guard then narrows the exposure to one gateway round trip rather than
 * closing it; see `docs/concurrent-edits.md`.
 *
 * Per-client write serialization (`upstreams.ts`) still matters and is not
 * replaced by this: it orders *this* client's writes so two of the operator's
 * own saves cannot interleave between the read and the write above.
 */
export async function guardedReplace<TResource, TPayload>(
  options: GuardedReplaceOptions<TResource, TPayload>,
): Promise<TResource> {
  return verifiedAttempts({
    ...options,
    operation: "save",
    proposedSnapshot: (proposed: TPayload) => options.guard.select(proposed),
  });
}

export interface GuardedRemoveOptions<TResource> {
  readonly resource: string;
  readonly id: string;
  readonly namespace: string;
  readonly guard: WriteGuard<TResource>;
  readonly read: () => Promise<TaggedRead<TResource>>;
  /** The `DELETE`, sent with `If-Match: ifMatch` when it is not `null`. */
  readonly remove: (ifMatch: string | null) => Promise<void>;
}

/**
 * Delete a resource only if it still holds what the editor was showing.
 *
 * The same verify-then-write as `guardedReplace`, with a `DELETE` in place of
 * the `PUT`: an operator who confirms "delete this proxy" on a page opened
 * before someone else repointed it is refused rather than deleting a
 * configuration they never saw. A `412` caused only by fields the guard does
 * not compare is re-verified and re-sent, exactly as for a save.
 */
export async function guardedRemove<TResource>(
  options: GuardedRemoveOptions<TResource>,
): Promise<void> {
  return verifiedAttempts<TResource, null, void>({
    ...options,
    operation: "delete",
    propose: () => null,
    proposedSnapshot: () => options.guard.baseline,
    write: (_payload, ifMatch) => options.remove(ifMatch),
  });
}

interface VerifiedAttemptOptions<TResource, TPayload, TResult> {
  readonly resource: string;
  readonly id: string;
  readonly namespace: string;
  readonly operation: GuardedOperation;
  readonly guard: WriteGuard<TResource | TPayload> | WriteGuard<TResource>;
  readonly read: () => Promise<TaggedRead<TResource>>;
  readonly propose: (current: TResource) => TPayload;
  readonly proposedSnapshot: (proposed: TPayload) => BaselineSnapshot;
  readonly write: (payload: TPayload, ifMatch: string | null) => Promise<TResult>;
}

async function verifiedAttempts<TResource, TPayload, TResult>(
  options: VerifiedAttemptOptions<TResource, TPayload, TResult>,
): Promise<TResult> {
  const guard = options.guard as WriteGuard<TResource>;
  const expected = resourceFingerprint(guard.baseline);

  for (let attempt = 1; ; attempt += 1) {
    const { value, etag } = await options.read();
    const current = guard.select(value);
    const proposed = options.propose(value);
    const refuse = () =>
      new StaleResourceError({
        resource: options.resource,
        operation: options.operation,
        id: options.id,
        namespace: options.namespace,
        original: guard.baseline,
        current,
        proposed: options.proposedSnapshot(proposed),
      });

    if (resourceFingerprint(current) !== expected) throw refuse();

    try {
      return await options.write(proposed, etag);
    } catch (error) {
      if (etag === null || !isPreconditionFailed(error)) throw error;
      if (attempt >= PRECONDITION_ATTEMPTS) throw refuse();
    }
  }
}
