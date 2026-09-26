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
| Does `GET /proxies/{id}` carry an `ETag`? | **Yes** (`gatewayIssuesEtag: true`) |
| `PUT` carrying a stale or invented `If-Match` | **`412` and nothing written** (`gatewayHonoursIfMatch: true`) |
| `PUT` carrying a malformed `If-Match`, and `POST /proxies` carrying any `If-Match` | **`400` and nothing written** (`malformedIfMatchStatus: 400`, `createIfMatchStatus: 400`) |

The precondition is ferrum-edge#5661, merged on Ferrum Edge `main` on
2026-09-23 and released in Ferrum Edge v0.9.7, the image CI pins (`edge.image`
in `docs/compatibility.md`) and the release Foundry v0.2.0 pairs with. The
pairing requires it, so `scripts/gateway-contract-smoke.mjs` fails when the
pinned gateway issues no tag. The contract itself still checks that the two
halves agree on any gateway: one that tags reads must refuse a stale tag, and
one that issues no tag must not be enforcing a precondition Foundry has no way
to satisfy.

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
6. A committed-but-not-live answer — `503` with `X-Ferrum-Config-Cursor` or
   `applied: false` — is a committed write, not a failure. The editor reseeds
   its form **and** its baseline from one fresh read; see
   [Committed but not yet live](#committed-but-not-yet-live).

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

A re-read after a `412` that carries no strong tag (the cached-config
fallback) is refused rather than written unconditionally: the `412` proved a
commit, and an untagged read can lag it and still match the baseline, so a
`PUT` without `If-Match` from it could revert that commit.

The `412` is an outcome the guard resolves, so the conditional `PUT` opts it
out of the global error popup with `HANDLED_STATUSES` (`src/api/client.ts`);
every other failure of the same request is still reported.

### Without a tag

When the verification read carries no usable `ETag` — a read served from the
cached-config fallback, a gateway predating ferrum-edge#5661 (outside the
qualified pairing), or a weak tag
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
| Upstream targets save | `targets` the add/edit form was opened against (a row removal: the list on screen when it was clicked) | the read its settings are rebuilt from |
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

## Committed but not yet live

Edge answers a proxy, upstream, or consumer `PUT` or `DELETE` whose row
committed, but whose generation the in-process reload could not make live,
with `503` and either a valid `X-Ferrum-Config-Cursor` or a body carrying
`applied: false` (the "committed but not live" family of
`NamespaceAdmissionUnavailable` in Edge's `openapi.yaml`). The nothing-applied
`503` has no `applied` field and never carries the cursor. The row is durable;
only the live apply lagged.

`committedNotLiveAnswer()` (`src/api/gatewayMetadata.ts`) is the one predicate
for that distinction. The live-apply monitor, restore, and the API client all
use it. For a configuration write, the client's `beforeError` hook marks the
rejection as a **committed write** (`getCommittedWrite()` in
`src/api/client.ts`, which follows the `cause` chain like
`isUnobservedWrite()`), and then:

- **No error popup.** The live-apply banner already says "Committed, not yet
  proven live" and monitors the cursor, or reports a commit without a valid
  cursor as unverifiable. `getApiErrorMessage()` phrases it the same way, never
  as "Failed to …".
- **Cached reads are refreshed.** The application `MutationCache`
  (`src/lib/queryClient.ts`) invalidates on a committed write exactly as on an
  unobserved one, and the proxy, upstream, and consumer update hooks also
  refresh the resource's detail and list before the caller sees the outcome,
  as their `onSuccess` does.
- **Nothing is resent.** The retry policy refuses a committed `503` even on a
  read.

### The decision: reseed, do not adopt

A save that commits must move the baseline, or the next Save re-reads the
gateway, finds the operator's own change, and refuses it as a concurrent edit
(#430). There are three ways to move it, and only one keeps the seed-once
invariant ("the baseline only ever describes what the form is showing"):

| Option | Why not / why |
| --- | --- |
| Keep the old baseline | The next Save is refused with `StaleResourceError` listing this operator's own change. |
| Adopt the draft payload | Not a canonical representation: a payload spells a clear as `null` where a read omits the key, so it never fingerprints like the stored resource, and the next Save is refused anyway. |
| Adopt a fresh read, keep the form's fields | A writer who committed between this save and that read would be adopted into the baseline while the form still shows this operator's values — the next Save would silently revert them. That is the silent rebase the guard exists to prevent. |
| **Reseed form and baseline from one fresh read** | **Chosen.** Both come from the same read, so the baseline never describes content the form is not showing. The draft is not lost: it is what the gateway now holds. A writer in the gap is displayed, not overwritten. |

`reseedAfterCommit()` (`src/hooks/useEditBaseline.ts`) does this for the
proxy, upstream, and consumer detail forms: the same refetch-and-remount as
"Discard my draft and reload", run for the operator because their draft was
committed. The toast says "Proxy saved: committed, not yet proven live" and
points at the live-apply banner for the cursor. If that read fails, nothing
moves: the form keeps the draft, the toast says to reload before saving again,
and a further Save is judged against the old baseline — the honest outcome
when Foundry cannot say what the gateway holds, which the stale-write dialog's
"Discard my draft and reload" resolves.

The two single-field editors take their guard from the list they were
computed from rather than the settings form's seed. The update hooks refresh
that resource before the rejection reaches them, so an upstream **targets**
save or a consumer **ACL** change that commits closes its editor like a
success, and the next edit is computed from the committed list.

An upstream target add or edit form holds a draft, so it follows the seed-once
rule too: opening it captures the target list on screen and the guard built
from it, and the new list is computed from that capture. A background refetch
that brings a concurrent change to the targets updates the rows on screen but
not the open form's basis, so its save is refused instead of being approved
against a list the draft was never edited from (#445). Only `targets` is
compared, so a settings change picked up by the same refetch still composes.
"Discard my draft and reload" from a targets refusal closes the target form
and leaves any settings draft alone.

The open form and its captured list are one piece of state, so dropping the
draft closes the form; a save handler that ever finds no draft reports an
error instead of returning silently. An edit form is bound to its target's
identity — `host:port` plus how many earlier targets share that address
(`targetIdentities()`, `src/lib/upstreamTargets.ts`) — not to a row position,
so a refetch or a removal that shifts the rows neither remounts the form nor
moves it onto another target (#448). If a refetch no longer lists that
target, the form stays where it was with a notice, and its save is refused
with the comparison.

A row removal from the same page moves an open form's basis only when the form
was opened against the very list the removal was computed from, and only onto
an upstream known to hold the result: the gateway's answer, or — when the
removal answered committed-but-not-live — a fresh read whose `targets`
fingerprint equals the list the removal wrote. A read that differs may carry
another writer's change, so the form keeps its old basis and its save is
refused rather than rebased.

A read served from the cached-config fallback (`X-Data-Source: cached`) can
lag the commit, and the form would then show the older content. That is the
same exposure as seeding an editor from such a read in the first place: the
next Save is refused if its verification read comes from the database, and is
covered only by [Without a tag](#without-a-tag) if that read is cached too. The
cached-data banner is shown either way.

### Committed deletes

A committed delete **is** a completed delete. A delete has no response body to
adopt, so `removeCommitted()` (`src/hooks/retireDeletedDetail.ts`) resolves the
proxy, upstream, and consumer delete mutations with `committed` set rather than
rejecting them. Their `onSuccess` then retires the seeded detail entry and
invalidates the lists (and, for a proxy, the cascade) exactly as for a `204`,
and the detail page leaves with "Proxy deleted: committed, not yet proven live"
instead of "Failed to delete proxy". Until then the cached detail would have
seeded an editor for a resource the gateway no longer holds.

### Committed credential writes

A consumer credential append, basic replacement, indexed delete, or delete of
all basic credentials that commits is a completed write too. The credential
hooks (`writeCredential()` in `src/hooks/useConsumers.ts`) resolve with
`committed` set, refresh the consumer exactly as for a `2xx`, and the
credential card completes: the secret is shown once in the copy-once receipt,
the draft is cleared, the form and its submit action close, and the card keeps
a "committed, not yet proven live" status line until the operator's next
credential action. Treating the commit as a failure left the submitted secret
armed, so a second click appended it again (#451).

A credential write whose answer was lost may also have committed. The hook
records the consumer revision when the lost answer arrives, re-reads the
consumer, and rejects with that revision (`UnobservedCredentialWriteError`).
The card keeps the draft — it may be the only copy of a stored secret — but
refuses any add or replacement until a read newer than that revision has
landed. The revision the form rendered when it submitted is not used: a
refetch that landed mid-write would already have passed it, and a failed
re-read would then re-arm the form on a read older than the error (#466). An
add is also refused while one is in flight, checked synchronously so a
double submit cannot write twice.

The re-read cannot confirm presence: secrets are listed as `[REDACTED]` and
basic credentials are not listed at all. For a key, JWT, or HMAC add, the card
compares the count it listed when the write was issued with the re-read and
says the credential was *likely* stored (or likely not). For a basic add it
says presence cannot be observed and points to "Replace basic credentials",
which is safe to repeat but revokes every existing basic password. This
"outcome unknown" status line survives Cancel and reopening the form, and is
cleared only when a later add, replacement, or delete of all basic credentials
from the card completes. Deleting one listed credential does not clear it: the
card keeps the lock and, when the deleted entry was listed before the add,
lowers the recorded count by one so the comparison stays valid. The lock is
monotonic — only a read strictly newer than the recorded revision re-arms the
form.

An indexed delete whose answer was lost closes its confirmation, since the
index may now name a different credential. No failure rethrows the ky error,
which holds the secret-bearing request options: a definite rejection becomes a
plain error whose message carries the gateway's detail. Every submitted value
is replaced by `[REDACTED]` throughout the parsed error body — every string,
keys included, in raw, JSON-escaped, and whitespace-trimmed forms — before the
detail is extracted, since extraction trims each field and cuts it to 600
characters and a shortened or trimmed echo would no longer match the submitted
value. An append opts out of the global error popup, which would show the raw
gateway body.

### Every other secret-bearing write

The same redaction (`src/api/secretRedaction.ts`) covers every write whose
body carries a secret: consumer create, plugin configuration create and update
(so a membership plan's rollback too), upstream create and update, TLS managed
record and ACME certificate writes, ACME order creation and renewal, TLS
validation, and batch create (#478), backup restore, and API spec import and
replacement (#485). `secretValues()` finds the secrets by
position rather than by resource: every string under a credential-shaped field
name at any depth (the conflict dialog's `isRedactedField` list, plus
`headers` maps, webhooks, service-account documents, and camelCase `*Key`
fields), and the userinfo, path, query, and fragment of any URL; a bare
`scheme://host[:port]` stays readable. A multi-line value such as a PEM key is
also redacted line by line, for any line of 16 characters or more, since a
parser that rejects one line quotes it rather than the document; the PEM armor
lines (`-----BEGIN CERTIFICATE-----`) are the same text in every document and
stay readable.

A plugin configuration's `config` — in a plugin write or a batch entry — is
classified the way Ferrum Edge v0.9.7 projects it for a non-admin read
(`src/admin/plugin_config_projection.rs`), so nothing Edge hides from a read
can come back in a refusal: `PLUGIN_SENSITIVITY` transcribes Edge's
per-plugin schema rules (for example `ai_semantic_cache`'s
`semantic_embedding_auth_header`, `proxy_alerts`' `channels.*.body_template`,
`api_chargeback_sink`'s `clickhouse.insert_query_params.*`, and every
`kafka_logging` `producer_config` property off Edge's safe list, such as
`ssl.key.pem`), then Edge's name floor and URL sweep apply beneath them. A
plugin Edge's table does not name — a custom plugin, or a built-in newer than
the paired release — has no schema to classify by, so every string in its
`config` is treated as secret. Edge's operator-configured
`FERRUM_LOG_REDACT_METADATA_KEYS` extras are not visible to Foundry.

The table lives in `src/api/pluginSensitivity.ts` with the Edge commit it was
checked against (`PLUGIN_SENSITIVITY_SOURCE`). The Pinned Gateway Contract job
runs `scripts/plugin-sensitivity-drift.mjs`, which fetches
`plugin_config_projection.rs` at `edge.source_commit`, parses
`PLUGIN_SENSITIVITY_SCHEMAS` and `KAFKA_SAFE_PRODUCER_PROPERTIES`, and fails on
any plugin or rule that differs, and on any rule shape or sensitivity kind it
cannot read. Its unit test fails when the recorded commit is not the pinned
one, so moving the Edge pin cannot leave the table unchecked (#487).

A backup restore carries every resource of a namespace. `restoreSecrets()` is
`secretValues()` over the backup plus each API spec document it holds, which
travels gzip-compressed and base64-encoded and is taken whole. An API spec
document for import or replacement is text: `specDocumentSecrets()` classifies a
JSON document by position — each `x-ferrum-plugins` entry by its plugin's rules,
anything else by field name and URL — with an entry that is not a plugin
configuration unclassified throughout. Foundry has no YAML parser, so a YAML (or
malformed JSON) document is unclassified throughout: every scalar it could hold,
found line by line without parsing (each `key: value` value, sequence entry,
flow element, and quoted scalar unquoted and unescaped). Several pairs on one
line (`"a": "x", "b": "y",`, or a flow mapping continued onto a line that starts
with a key) are each found. A quoted key needs no space before its value
(`"api_key":"…"`), as in a JSON-like document that is not valid JSON, and a
double-quoted scalar continued with a trailing `\` is recorded without it, both
line by line and joined as the scalar joins it, so short pieces cannot leak as
one longer value. A folded echo of a multi-line scalar is therefore redacted
piece by piece. Both surfaces report every failure themselves (`SILENT_ERRORS`),
and a spec write's unknown outcome keeps only the redacted error as its `cause`.

A value that is secret only because nothing classifies it — every string of an
unknown plugin's config, every scalar of a YAML spec document — is redacted
wherever it occurs when it is 8 characters or longer. A shorter one (`a`, `1`,
`on`, `error`) also occurs in ordinary words, in the keys of the gateway's
error body, and in the `[REDACTED]` marker itself, so it is redacted only
where it stands as a whole token of a string value, and never in an object
key: the body's `error` and `code` stay readable and the restore card's
recovery details stay recognizable. A value that is classified is redacted
wherever it occurs in a string value whatever its length. No value shorter
than 8 characters, classified or not, is matched in the body's structure:
its object keys, and the fixed vocabulary callers recognize a failure by —
the body's top-level `code`, `phase`, `rollback`, `failure_class`, and
`confirmation_required`; a nested field of the same name is redacted in full. A
restore whose backup holds a credential such as `api`, `ro`, or `true` still
gets a recognizable `api_specs_at_risk` confirmation, rollback outcome, and
upload-phase timeout (#485). Every match is found in the original text and
replaced in one pass, overlapping matches as one marker, so no replacement
can split a marker another one wrote (#487).

`withRedactedFailure()` replaces any failure of such a write with a
`RedactedWriteError`: the redacted message, the original error's `name`
(`HTTPError`, `TimeoutError`, `UnboundNamespaceError`), a bodiless copy of the
response (status and headers), and the redacted parsed body as `data`, with no
`request`, `options`, or `cause`. `getApiErrorDetail()`,
`isPreconditionFailed()`, and the outcome classifiers read it as they read a ky
`HTTPError`, and the committed-write and unobserved-write markers are carried
over, so a guarded save's `412` handling, "committed, not yet proven live",
and "outcome unknown" are unchanged. The global error popup is raised from
ky's own error, before redaction could run, so each such request carries
`REDACT_ERRORS`: the client holds the report it would have raised, and
`withRedactedFailure()` raises it once the submitted secrets are removed from
its body and the outcome's detail, with the same status, URL, and unobserved
outcome — a write whose
answer was lost still opens the "Outcome unknown" dialog, BFF code included
(`docs/client-recovery.md`). A failure the popup never reports (a committed
write, a guarded save's handled `412`) is not held. Writes whose form renders
every refusal itself (consumer credential writes, managed TLS create, ACME
order creation and renewal, TLS validation) keep `SILENT_ERRORS` instead. A plugin membership plan includes the
gateway's redacted reason in its own message. Every such mutation hook —
restore and API spec import and replacement included — sets `gcTime: 0`, so
the submitted body does not linger in the mutation cache's variables after
the form is gone. Consumer metadata saves are not
covered because their body carries no submitted secret: credentials in it come
from the read the save is sent against, where they are `[REDACTED]`.

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
whole mechanism exists to prevent. Only three things move a baseline: a
canonical response the gateway just accepted from this editor, an explicit
discard and reload, and the reseed after a committed-but-not-live save — which
is that same reload, run because the draft is already on the gateway.

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
| Target form basis survives a background refetch; unrelated settings still compose; the form follows its target identity when rows shift, including a renumbered duplicate `host:port`; a committed-but-not-live removal is adopted only when the read holds exactly its result, up to omitted empty optional members | `src/routes/upstreams/TargetEditor.test.tsx`, `src/lib/upstreamTargets.test.ts`, `scripts/gateway-contract-smoke.mjs` |
| Restore retires the restored namespace's detail caches and inactive lists | `src/hooks/restoreDetailCache.test.tsx`, `src/components/forms/BackupRestoreCard.recovery.test.tsx` |
| Guarded deletes, consumer saves and rotation re-send, nested redaction of plugin `config` | `src/api/conditionalWrite.test.ts`, `src/lib/resourceBaseline.test.ts` |
| Plugin editor baseline, membership writes conditional on their reads | `src/lib/pluginMembership.test.ts`, `src/lib/pluginMembership.binding.test.ts` |
| Refused delete dialog | `src/routes/proxies/concurrentEdit.test.tsx` |
| Echoed secrets redacted on consumer create, plugin, upstream, TLS, and batch writes, in the error and in the popup; plugin `config` classified by Edge's projection; no request retained; status, `412`, and outcome markers kept | `src/api/secretRedaction.test.ts`, `src/routes/consumers/createSecretEcho.test.tsx` |
| Committed-but-not-live classification, popup suppression, cache refresh, save-twice regression | `src/api/committedWrite.test.ts`, `src/lib/queryClient.test.ts` |
| Editor reseed after a committed save; committed delete reported as deleted | `src/routes/proxies/concurrentEdit.test.tsx` |
| Committed delete retires the seeded detail and list caches | `src/hooks/deleteDetailCache.test.tsx` |
| Committed and unobserved credential writes disarm the card and reconcile before a retry | `src/routes/consumers/credentialCommittedWrite.test.tsx` |
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

- **The cached-config fallback.** A read Edge serves from its cached
  configuration (`X-Data-Source: cached`) carries no tag, so a write verified
  against it is sent unconditionally and the guard narrows the race to one
  round trip rather than closing it. That is Edge's contract, not a pinning
  gap: the tag cannot be issued from a cache that may lag the database.
- **A browser-level two-session journey.** Belongs in the critical-journey
  suite tracked by #380.
