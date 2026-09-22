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
`scripts/gateway-contract-smoke.mjs`. Against
`ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`
it records:

| Observation | Result |
| --- | --- |
| Unguarded stale `PUT` after another administrator's accepted change | **Accepted; the newer value is reverted** (`unguardedStaleWriteReverts: true`) |
| The same draft submitted through Foundry's guard | **Refused before the wire** (`guardedStaleWriteRefused: true`) |
| `PUT` carrying `If-Match: "<a revision this proxy never had>"` | **`200`** — the header is ignored (`gatewayHonoursIfMatch: false`) |

The third row is the important one: **the admin API has no conditional-write
precondition.** The surveyed `openapi.yaml` declares no `If-Match` parameter and
no `412` response on any resource `PUT`; the only conditional semantics in the
spec are `If-None-Match`/`ETag` on `GET /api-specs/{id}`, which are cache
validators for reads. The contract asserts `status !== 412`, so the day Edge
starts enforcing a precondition, CI fails and points here.

## What Foundry does

`src/api/conditionalWrite.ts` wraps a full-replacement write in a guard:

1. The editor captures a **baseline** when it is seeded — the resource reduced
   to the fields this write would overwrite (`src/lib/resourceBaseline.ts`).
2. At submit time the guard re-reads the resource and compares the canonical
   fingerprint of that reduction.
3. A mismatch throws `StaleResourceError`. **Nothing is sent.**
4. A match performs the `PUT`, and the accepted response becomes the new
   baseline.

### This is a guard, not a compare-and-swap

The verification read and the write are two requests. A writer that commits
between them is not detected and is still overwritten. What the guard buys:

- the exposure shrinks from "however long the editor stayed open" — minutes to
  hours — to one gateway round trip;
- it detects **any** writer, not just another Foundry tab: a second Foundry
  deployment, the seeding scripts, Terraform, or a direct admin-API client, all
  of which local bookkeeping cannot see;
- the refusal is real — the stale body never reaches the wire, so there is no
  window in which the gateway holds the wrong configuration.

Closing the remainder requires an Edge precondition contract. When one exists,
the atomic check belongs inside `write`, and the verification read becomes a
diagnosis aid rather than the enforcement point. Nothing else in the design
changes: the baseline is already the value a precondition would be derived
from.

A BFF-local lock is **not** an alternative. It cannot see another BFF replica
or a direct admin-API client, which is exactly the population the guard is for.

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

1. **The draft survives.** The dialog does not touch the form. "Keep my draft"
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
| Draft preserved, no reapply control, keep/discard behavior | `src/routes/proxies/concurrentEdit.test.tsx` |
| Same-client write ordering still composes | `src/api/upstreams.targetWrites.test.ts` |
| Real gateway behavior and the `If-Match` probe | `scripts/concurrent-edit-contract.mjs` |

## Still open

- **Atomicity.** Requires a conditional-write contract in `ferrum-edge`. Track
  it there; this repository's integration point is ready for it.
- **Consumers and plugin configurations.** Their editors have their own
  fresh-read protections (`docs/client-recovery.md`) but do not yet capture an
  editor baseline. The guard is resource-agnostic; wiring them is the same
  three lines as the proxy editor.
- **A browser-level two-session journey.** Belongs in the critical-journey
  suite tracked by #380.
