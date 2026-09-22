/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – guarded full-replacement writes                   */
/* ------------------------------------------------------------------ */

import {
  resourceFingerprint,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";

/**
 * The three sides an operator needs to resolve a concurrent-edit conflict.
 * Values are rendered through `formatBaselineValue`, which redacts
 * credential-shaped fields; nothing here is written to browser storage.
 */
export interface StaleResourceDetail {
  /** Human-readable resource kind, e.g. `"proxy"`. */
  readonly resource: string;
  readonly id: string;
  /** The namespace the refused write was bound to. */
  readonly namespace: string;
  /** The content the editor was opened against. */
  readonly original: BaselineSnapshot;
  /** The content the gateway holds now. */
  readonly current: BaselineSnapshot;
  /** The content this editor was about to write. */
  readonly proposed: BaselineSnapshot;
}

/**
 * Raised instead of committing a full-replacement write whose baseline no
 * longer matches the gateway. The draft that produced it is untouched: the
 * caller keeps the form mounted and the operator decides what happens next.
 *
 * This is never retried automatically. Re-sending the same body against a
 * fresh read is exactly the silent overwrite the guard exists to prevent.
 */
export class StaleResourceError extends Error {
  readonly detail: StaleResourceDetail;

  constructor(detail: StaleResourceDetail) {
    super(
      `This ${detail.resource} changed on the gateway since you opened it. ` +
        "Your draft was not sent.",
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

export interface GuardedReplaceOptions<TResource, TPayload> {
  /** Resource kind, used in the conflict message and dialog heading. */
  readonly resource: string;
  readonly id: string;
  readonly namespace: string;
  readonly guard: WriteGuard<TResource | TPayload>;
  /** The body this editor wants to send. */
  readonly proposed: TPayload;
  /** A fresh authoritative read, bound to the same namespace as the write. */
  readonly read: () => Promise<TResource>;
  readonly write: (payload: TPayload) => Promise<TResource>;
}

/**
 * Verify that nobody else has changed a resource since an editor opened it,
 * then perform the full-replacement write.
 *
 * ## Why this is a guard and not a compare-and-swap
 *
 * The verification read and the write are two requests. A writer that commits
 * between them is not detected and is still overwritten. Ferrum Edge's admin
 * API exposes no conditional-write precondition on resource `PUT` — there is
 * no `If-Match` parameter and no `412` response on the surveyed revision of
 * `openapi.yaml` — so there is currently nothing atomic to bind to. What this
 * does buy:
 *
 * - the exposure shrinks from "as long as the editor stayed open" to one
 *   gateway round trip;
 * - it detects **any** writer, including a second Foundry deployment, the
 *   seeding scripts, or a direct admin-API client, because it compares the
 *   gateway's own content rather than local bookkeeping;
 * - the refusal is a real refusal — the stale body never reaches the wire.
 *
 * When Edge gains a precondition contract, the atomic check belongs in
 * `write`, and this verification read becomes a diagnosis aid rather than the
 * enforcement point. `docs/concurrent-edits.md` tracks that migration.
 *
 * Per-client write serialization (`upstreams.ts`) still matters and is not
 * replaced by this: it orders *this* client's writes so two of the operator's
 * own saves cannot interleave between the read and the write above.
 */
export async function guardedReplace<TResource, TPayload>(
  options: GuardedReplaceOptions<TResource, TPayload>,
): Promise<TResource> {
  const { guard } = options;
  const expected = resourceFingerprint(guard.baseline);
  const current = await options.read();
  const currentSnapshot = guard.select(current);

  if (resourceFingerprint(currentSnapshot) !== expected) {
    throw new StaleResourceError({
      resource: options.resource,
      id: options.id,
      namespace: options.namespace,
      original: guard.baseline,
      current: currentSnapshot,
      proposed: guard.select(options.proposed),
    });
  }

  return options.write(options.proposed);
}
