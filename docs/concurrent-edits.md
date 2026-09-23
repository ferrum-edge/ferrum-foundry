# Concurrent edits on full-replacement writes

Proxies, upstreams, plugin configurations, and consumers are written with a
full-replacement `PUT`: the body Foundry sends becomes the resource, and every
field the body omits is reset to its schema default. That makes a stale draft
dangerous in a way a partial update is not — submitting an editor that was
opened five minutes ago does not merely fail to include someone else's change,
it actively reverts it.

This document records what the gateway does, what Foundry now does about it,
and what is still open.

## Measured baseline

`scripts/concurrent-edit-contract.mjs` runs the two-administrator sequence
against the pinned Ferrum Edge image used by the `Pinned Gateway Contract` CI
job, and is executed on every pull request from
`scripts/gateway-contract-smoke.mjs`. It records:

| Observation | Result |
| --- | --- |
| Unguarded stale `PUT` after another administrator's accepted change | **Accepted; the newer value is reverted** (`unguardedStaleWriteReverts: true`). Omitting `If-Match` keeps last-writer-wins on every Edge revision. |
| The same draft submitted through Foundry's guard | **Refused; nothing is written** (`guardedStaleWriteRefused: true`) |
| Does `GET /proxies/{id}` carry an `ETag`? | `gatewayIssuesEtag` |
| `PUT` carrying a stale or invented `If-Match` | `412` and nothing written on a gateway that tags reads (`gatewayHonoursIfMatch: true`); ignored on one that does not |

The precondition is ferrum-edge#5661, merged on Ferrum Edge `main` on
2026-09-23 and not yet in any published release or image. The Edge image CI
pins (`edge.image` in `docs/compatibility.md`, an interim development build)
predates it and issues no tag, so Foundry sends it no `If-Match`. The
contract fails if the two halves disagree: a gateway that tags reads must
refuse a stale tag, and a gateway that issues no tag must not be enforcing a
precondition Foundry has no way to satisfy.

## The Edge contract

`GET /proxies/{id}`, `/upstreams/{id}`, `/consumers/{id}`, and
`/plugins/config/{id}` return a strong `ETag`: a keyed MAC over the full stored
resource, bound to its kind, namespace, and id. A `PUT` or `DELETE` carrying it
as `If-Match` is refused with `412 Precondition Failed`, writing nothing,
unless the stored resource still has that representation. Edge evaluates the
comparison under the namespace config admission lease that every admin writer
of these families takes — CRUD, `/batch`, `/restore`, spec import, credential
routes, and the same paths on another control-plane replica — so nothing can
commit between the comparison and the write.

The parts of that contract Foundry relies on:

- **Write responses carry no tag**, and neither does the cached-config `GET`
  fallback (`X-Data-Source: cached`). A tag always comes from a fresh read.
- **Comparison is strong.** A weak `W/"…"` tag never matches.
- **`If-Match` on any other mutating route is `400`**, not ignored — `POST`
  creates, `/batch`, `/restore`, trust bundles, API specs, and credential
  sub-routes. Foundry sends it only on the resource `PUT` paths the guard
  covers.
- **After a `412`, reapply the intended edit to the current representation.**
  Resending the same body with the fresh tag would revert the change that
  caused the refusal.

## What Foundry does

`src/api/conditionalWrite.ts` wraps a full-replacement write in a guard:

1. The editor captures a **baseline** when it is seeded — the resource reduced
   to the fields this write would overwrite (`src/lib/resourceBaseline.ts`).
2. At submit time the guard re-reads the resource, keeping the read's `ETag`,
   and compares the canonical fingerprint of that reduction.
3. A mismatch throws `StaleResourceError`. **Nothing is sent.**
4. A match sends the `PUT` with `If-Match` set to the tag of **that same
   read**. If anything was written after it, Edge answers `412` and writes
   nothing; the guard goes back to step 2.
5. An accepted response becomes the new baseline.

The two checks compose. The baseline comparison proves the verified read holds
nothing this draft would revert; `If-Match` proves nothing has been written
since that read. Together the write commits only against content equal to what
the editor opened, on every field the write replaces.

### Where the tag comes from

Always the verification read — never the editor's original load, never a
later background refetch. The editor's baseline is compared field by field
precisely because the tag cannot be: it covers fields the write does not
replace (plugin associations, and for a targets save, every upstream setting),
so a tag captured at seed time would refuse saves that race nothing. Adopting
a tag from any read other than the one just compared would let an older draft
pass the precondition against content the operator never saw.

### After a `412`

A `412` means "something was written since the verification read", not "this
draft conflicts". The guard re-reads and verifies from the top:

- a change to anything the draft would overwrite fails the comparison and
  raises `StaleResourceError`, carrying the content that caused it;
- a change only to fields the draft leaves alone — a plugin attached from the
  plugin pages, an upstream setting changed while the Targets tab saves —
  passes, and the write is re-sent against the fresh tag, with the targets
  save rebuilding its body from the fresh settings.

That re-send is not a replay of a refused write. It is exactly the decision the
guard would have made had the operator pressed Save a moment later, and it
cannot revert anything because every field in the body is either compared or
taken from the read it is sent against. `proxies.update` enforces that for
the one uncompared writable field: a guarded proxy body never carries
`plugins`, whatever the caller built. The unguarded targets write
(`updateTargets(…, null)`) is conditional too, since it rebuilds every
setting from its read. After `PRECONDITION_ATTEMPTS` (3)
consecutive rounds the save is refused anyway, so a resource under continuous
churn cannot hold a save open.

The `412` is an outcome the guard resolves, so the conditional `PUT` opts it
out of the global error popup with `HANDLED_STATUSES` (`src/api/client.ts`);
every other failure of the same request is still reported.

### Without a tag

When the verification read carries no usable `ETag` — a gateway predating
ferrum-edge#5661, a read served from the cached-config fallback, or a weak tag
an intermediary produced — Foundry sends the `PUT` without `If-Match`. The
guard then narrows the race rather than closing it: a writer that commits
between the verification read and the write is not detected. What the guard
still buys:

- the exposure shrinks from "however long the editor stayed open" — minutes to
  hours — to one gateway round trip;
- it detects **any** writer, not just another Foundry tab: a second Foundry
  deployment, the seeding scripts, Terraform, or a direct admin-API client, all
  of which local bookkeeping cannot see;
- the refusal is real — the stale body never reaches the wire.

A BFF-local lock is **not** an alternative in either case. It cannot see
another BFF replica or a direct admin-API client, which is exactly the
population the guard is for. The BFF forwards `If-Match` and `ETag` unchanged
(`server/proxy.ts`).

## What is compared, and what is not

A baseline is not the whole response. Two categories are excluded, and both
exclusions exist to avoid refusing writes that are not racing anything:

- **Server-managed fields** (`created_at`, `updated_at`, `namespace`,
  `api_spec_id`). `updated_at` in particular advances on writes this editor is
  not competing with, and on namespaces it is an observation timestamp stamped
  per request.
- **Fields this write never replaces.** A proxy save omits `plugins`, and an
  omitted `plugins` key tells Edge to preserve the live associations — so a
  membership change made from the plugin pages cannot be lost by a proxy save
  and must not be reported as a conflict. Upstreams likewise exclude the
  mesh-projected fields the control plane owns.

The upstream **targets** editor replaces only `targets`, so its guard compares
only `targets`. That is deliberate: `upstreams.updateTargets` composes with a
settings save from this same client by design (#235/#254), and comparing the
whole upstream would turn that supported composition into a conflict. A
concurrent *target* change is still refused, which is the only thing that write
can lose.

## Which writes are guarded

| Write | Compared against | Conditional on |
| --- | --- | --- |
| Proxy settings save | the editor's seed, every field except `plugins` (never sent) | the verification read |
| Upstream settings save | the editor's seed, minus mesh-projected fields | the verification read |
| Upstream targets save | `targets` of the render the new list was built from | the read its settings are rebuilt from |
| Consumer Details save | the editor's seed, minus `credentials` and `labels` (never sent) | the read its credentials are taken from |
| Consumer ACL add/remove | the consumer the group list was computed from | the read its credentials are taken from |
| Plugin configuration save | the editor's seed, minus `labels` (never sent) | the membership plan's fresh read |
| Proxy / upstream / consumer / plugin delete from its detail page | the resource the page is displaying | the verification read |
| Every write inside a plugin membership plan | the plan's own `updated_at` preflight (#244) | the read that preflight compared |

### Consumers

A consumer `PUT` replaces represented credential types even when the body
omits `credentials`, so a metadata save has always taken the credentials from
a fresh read inside the consumer write queue (`docs/client-recovery.md`). That
read is now also the guard's verification read, and the `PUT` carries its tag.
A rotation that lands after it makes the gateway refuse the write rather than
replay the credentials it read; the guard re-reads, finds the metadata
unchanged, and re-sends with the rotated set. Credentials are excluded from the
comparison — a metadata draft cannot revert a rotation, and redacted
`[REDACTED]` markers say nothing about what changed.

Neither the Details form nor the ACL editor sends `labels`, and Edge preserves
the stored map when a `PUT` omits the key. A provisioner stamping a label
therefore cannot be reverted by these saves, so `labels` is left out of the
comparison — the same reasoning as `plugins` on a proxy. Plugin configuration
saves omit `labels` too and exclude it the same way.

### Plugin configurations and membership plans

A plugin save runs through the membership plan (`src/lib/pluginMembership.ts`),
which already re-reads every resource it writes and refuses when its
`updated_at` moved since the plan's preflight (#244). Two things changed:

- **Every write in the plan names the read it is based on.** The binding sends
  that read's tag as `If-Match` (`validatorOf` in
  `src/api/conditionalWrite.ts`), so each read-compare-write step is atomic and
  also catches a change that did not move `updated_at`. A `412` surfaces as the
  plan's own "changed during membership preflight" refusal, and in a rollback as
  "changed after Foundry updated it; … was not overwritten".
- **The editor's baseline is checked by the plan.** A configuration that
  changed since the editor opened is refused with `StaleResourceError` at the
  preflight read — before any association is touched — and again at the read
  the plugin `PUT` is conditional on. If that `PUT` gets a `412`, the plan
  re-reads once more so an editor whose draft is now stale sees the
  comparison rather than a generic plan failure.

### Deletes

A delete from a detail page is judged against the resource the page is
displaying at the moment the operator confirms — not the form's seed, so this
operator's own earlier saves (for example from the upstream Targets tab) never
block their delete. If another writer changed it, the delete is refused and
`StaleWriteDialog` shows what moved, with no draft column and no "delete
anyway". A plugin delete checks before detaching any proxy and again at the
read its final `DELETE` is conditional on.

## What the operator sees

`StaleWriteDialog` is shown when a save or a delete is refused. For a save it
keeps three properties:

1. **The draft survives.** Nothing from it was written — the guard refused
   it, or the gateway did with `412`. The dialog does not touch the form. "Keep my draft"
   closes it and the operator is back in their unsaved changes.
2. **There is no automatic reapplication and no "save anyway".** Re-sending the
   same body against the newer revision *is* the overwrite the guard refused.
   Re-applying means editing the fields again against current content, which
   the operator does themselves. "Discard my draft and reload" is the only
   other option, and it remounts the editor against a fresh read rather than
   rebasing dirty fields onto newer data.
3. **No secrets on screen.** Field values are rendered through
   `formatBaselineValue`, which replaces credential-shaped values with
   `[redacted]` while still showing that the field moved. A `*_path` field is
   shown, because a path to material is not the material — and the gateway
   never returns key bytes on these resources anyway. Nothing from the
   comparison is written to browser storage, telemetry, or logs.

### The writer can be this operator

The upstream settings form owns `targets` too, seeded once like every other
field. After a save from the Targets tab, the settings form still holds the
old list, so its next save would have reverted the target change. The guard
refuses it, and the dialog says the resource changed after the editor opened —
not that "someone else" did, because the other writer may be this same page.
Discard and reload picks up the new targets.

## Baselines and background refetches

The baseline follows the same seed-once rule as the form fields
(`src/lib/editorIdentity.ts`): it is captured from the first successful read
for an editor identity and is **not** advanced by a background refetch.
Adopting a newer refetch would let the guard pass while the form still held
values from the older read — a silent rebase, which is the failure mode this
whole mechanism exists to prevent. Only two things move a baseline: a canonical
response the gateway just accepted from this editor, and an explicit discard
and reload.

A namespace switch or a route change to another resource remounts the editor,
so the next successful read seeds a fresh baseline for the new tenant.

## Coverage

| Concern | Test |
| --- | --- |
| Reduction, fingerprint, three-way comparison, redaction | `src/lib/resourceBaseline.test.ts` |
| Two-session regression, unguarded baseline, re-seeded save, plugin-association non-conflict, targets scope | `src/api/writeGuard.test.ts` |
| `If-Match` from the verified read, a writer in the gap refused, re-send after a `412` on unowned fields, bounded retries, untagged and weak-tag fallback, popup opt-out | `src/api/conditionalWrite.test.ts` |
| Draft preserved, no reapply control, keep/discard behavior | `src/routes/proxies/concurrentEdit.test.tsx` |
| Same-client write ordering still composes | `src/api/upstreams.targetWrites.test.ts` |
| Guarded deletes, consumer saves and rotation re-send, nested redaction of plugin `config` | `src/api/conditionalWrite.test.ts`, `src/lib/resourceBaseline.test.ts` |
| Plugin editor baseline, membership writes conditional on their reads | `src/lib/pluginMembership.test.ts`, `src/lib/pluginMembership.binding.test.ts` |
| Refused delete dialog | `src/routes/proxies/concurrentEdit.test.tsx` |
| Mock gateway precondition contract | `scripts/mock-admin-gateway.test.mjs` |
| Real gateway behavior and the `If-Match` contract | `scripts/concurrent-edit-contract.mjs` |

## Local development

`scripts/mock-admin-gateway.mjs` implements the same contract — a tag on item
`GET`, `412` on a stale `If-Match` for `PUT`/`DELETE`, `404` before the
precondition, strong comparison, `400` for a malformed header or for
`If-Match` on any other mutating route — so the atomic path and the conflict
dialog can be exercised without a gateway. Its tag is an unkeyed digest; Edge
keys its tag so it cannot be used to test guesses of a redacted value.

## Still open

- **The pinned image.** The Edge image CI pins (`edge.image`, see
  `docs/compatibility.md`) predates ferrum-edge#5661, so CI exercises the
  untagged path and the guard narrows the race to one round trip rather than
  closing it. The release Foundry pairs with must include #5661; moving
  `edge.image` in `docs/compatibility.json` to it turns on the atomic path with
  no Foundry change, and the contract then asserts the `412`s.
- **A browser-level two-session journey.** Belongs in the critical-journey
  suite tracked by #380.
