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

The precondition is ferrum-edge#5661. Before it,
`ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`
— the image CI pins at the time of writing — issued no tag and answered `200`
to any `If-Match`. The contract fails if the two halves disagree: a gateway
that tags reads must refuse a stale tag, and a gateway that issues no tag must
not be enforcing a precondition Foundry has no way to satisfy.

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
guard would have made had the operator pressed Save a moment later, and by
construction it cannot revert anything. After `PRECONDITION_ATTEMPTS` (3)
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

## Families that keep their own contract

Plugin membership plans (`src/lib/pluginMembership.ts`) already run a
revision-aware contract established in #244: every write is preceded by a fresh
read whose `updated_at` must still match the preflight snapshot, and a mismatch
aborts the plan or refuses the rollback. That family passes `null` for the
editor guard rather than layering a second, differently-scoped comparison on
top of it.

## What the operator sees

`StaleWriteDialog` is shown when a save is refused. It keeps three properties:

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
| Real gateway behavior and the `If-Match` contract | `scripts/concurrent-edit-contract.mjs` |

## Still open

- **The pinned image.** CI's pinned gateway predates ferrum-edge#5661, so
  CI exercises the untagged path. Bumping the digest to a release that
  includes it turns on the atomic path with no Foundry change; the contract
  then asserts the `412`s.
- **Consumers and plugin configurations.** Edge tags them too. Their editors
  have their own fresh-read protections (`docs/client-recovery.md`) but do not
  yet capture an editor baseline. The guard is resource-agnostic; wiring them
  is the same three lines as the proxy editor, and their `PUT`s can then carry
  `If-Match` the same way.
- **Conditional deletes.** Edge honours `If-Match` on `DELETE` of the same
  four families. Foundry's deletes are confirmed from list rows rather than an
  editor baseline, so they are sent unconditionally.
- **A browser-level two-session journey.** Belongs in the critical-journey
  suite tracked by #380.
