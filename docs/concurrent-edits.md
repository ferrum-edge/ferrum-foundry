# Concurrent edits on full-replacement writes

Proxies, upstreams, plugin configurations, and consumers are written with a
full-replacement `PUT`: the body becomes the resource, and any field it omits is
reset to its default. A stale draft is therefore dangerous. Saving an editor
opened five minutes ago does not just miss someone else's change; it reverts
it.

This page covers what the gateway does, how Foundry guards these writes, and
what is still open.

## Measured baseline

`scripts/concurrent-edit-contract.mjs` runs a two-administrator sequence
against the pinned Ferrum Edge image. `scripts/gateway-contract-smoke.mjs`
runs it in the `Pinned Gateway Contract` CI job on every pull request. It
records:

| Observation | Result |
| --- | --- |
| Unguarded stale `PUT` after another administrator's accepted change | **Accepted; the newer value is reverted** (`unguardedStaleWriteReverts: true`). Without `If-Match`, the last writer wins. |
| The same draft submitted through Foundry's guard | **Refused; nothing is written** (`guardedStaleWriteRefused: true`) |
| Does `GET /proxies/{id}` carry an `ETag`? | **Yes** (`gatewayIssuesEtag: true`) |
| `PUT` with a stale or invented `If-Match` | **`412`, nothing written** (`gatewayHonoursIfMatch: true`) |
| `PUT` with a malformed `If-Match`, or `POST /proxies` with any `If-Match` | **`400`, nothing written** (`malformedIfMatchStatus: 400`, `createIfMatchStatus: 400`) |

Conditional writes come from ferrum-edge#5661, first released in Ferrum Edge
v0.9.7; v0.9.8, v0.9.9, and the v0.9.10 qualification candidate retain it
([compatibility.md](compatibility.md)).
`gateway-contract-smoke.mjs` fails if the pinned gateway issues no tag. The
contract itself also checks that the two halves agree on any gateway: one that
tags reads must refuse a stale tag, and one that issues no tag must not enforce
a precondition Foundry cannot satisfy.

## The Edge contract

`GET /proxies/{id}`, `/upstreams/{id}`, `/consumers/{id}`, and
`/plugins/config/{id}` return a strong `ETag`: a keyed MAC over the stored
resource, bound to its kind, namespace, and id. A `PUT` or `DELETE` that sends
it as `If-Match` is refused with `412 Precondition Failed`, writing nothing,
unless the stored resource still matches. Edge makes the comparison under the
namespace admission lease that every writer of these resources takes (CRUD,
`/batch`, `/restore`, spec import, credential routes, and other control-plane
replicas), so nothing can commit between the check and the write.

What Foundry relies on:

- **Write responses carry no tag**, and neither does the cached-config `GET`
  fallback (`X-Data-Source: cached`). A tag always comes from a fresh read.
- **Comparison is strong.** A weak `W/"…"` tag never matches.
- **`If-Match` on any other mutating route is `400`**, not ignored: `POST`
  creates, `/batch`, `/restore`, trust bundles, API specs, and credential
  sub-routes. Foundry sends it only on the resource `PUT`/`DELETE` paths the
  guard covers.
- **After a `412`, reapply the intended edit to the current resource.**
  Resending the same body with the new tag would revert the change that caused
  the refusal.

## What Foundry does

`src/api/conditionalWrite.ts` wraps each full-replacement write in a guard:

1. When the editor is seeded it captures a **baseline**: the resource reduced
   to the fields this write overwrites (`src/lib/resourceBaseline.ts`).
2. On submit the guard re-reads the resource, keeps that read's `ETag`, and
   compares the reduced fields against the baseline.
3. If they differ, it throws `StaleResourceError`. **Nothing is sent.**
4. If they match, it sends the `PUT` with `If-Match` set to the tag of **that
   same read**. If anything was written since, Edge answers `412` and the guard
   returns to step 2.
5. An accepted response becomes the new baseline.
6. A committed-but-not-live answer (`503` with `X-Ferrum-Config-Cursor` or
   `applied: false`) is a committed write, not a failure. The editor reseeds
   its form **and** baseline from one fresh read. See
   [Committed but not yet live](#committed-but-not-yet-live).

The two checks work together. The baseline comparison proves the verification
read holds nothing this draft would revert. `If-Match` proves nothing was
written after that read. So the write only commits against content equal to
what the editor opened, on every field it replaces.

### Where the tag comes from

Always the verification read, never the editor's original load or a later
background refetch. The baseline is compared field by field because the tag
covers fields the write does not replace (plugin associations, and for a
targets save every other upstream setting). A tag captured when the editor
opened would refuse saves that race nothing. A tag from any read other than the
one just compared would let an older draft pass against content the operator
never saw.

### After a `412`

A `412` means "something was written since the verification read", not "this
draft conflicts". The guard re-reads and verifies again:

- If a field the draft would overwrite changed, the comparison fails and
  `StaleResourceError` carries the new content.
- If only fields the draft leaves alone changed (a plugin attached from the
  plugin pages, an upstream setting changed while the Targets tab saves), the
  write is re-sent with the fresh tag. A targets save rebuilds its body from
  the fresh settings.

This re-send is the same decision the guard would have made had the operator
pressed Save a moment later. It cannot revert anything, because every field in
the body is either compared or taken from the read it is sent against.
`proxies.update` enforces this for the one uncompared writable field: a guarded
proxy body never carries `plugins`. The unguarded targets write
(`updateTargets(…, null)`) is conditional too, since it rebuilds every setting
from its read. After `PRECONDITION_ATTEMPTS` (3) consecutive `412`s the save is
refused, so constant churn cannot hold a save open.

If the re-read after a `412` has no strong tag (the cached-config fallback),
the write is refused rather than sent unconditionally. The `412` proved a
commit happened, and an untagged read can lag behind it and still match the
baseline.

The conditional `PUT` opts its `412` out of the global error popup with
`HANDLED_STATUSES` (`src/api/client.ts`), because the guard resolves it. Every
other failure is still reported.

### Without a tag

If the verification read has no usable `ETag` (a cached-config read, a gateway
older than ferrum-edge#5661, or a weak tag added by an intermediary), Foundry
sends the `PUT` without `If-Match`. The guard then narrows the race instead of
closing it: a writer that commits between the verification read and the write
is not detected. The guard still:

- shrinks the exposure from "as long as the editor was open" to one round trip;
- detects **any** writer, not just another Foundry tab: another Foundry
  deployment, the seed scripts, Terraform, or a direct admin API client;
- stops the stale body from ever being sent when a change is detected.

A lock inside the BFF is not an alternative. It cannot see another BFF replica
or a direct admin API client, which are exactly the writers the guard is for.
The BFF forwards `If-Match` and `ETag` unchanged (`server/proxy.ts`).

## What is compared, and what is not

A baseline is not the whole response. Two kinds of field are left out so that
writes which race nothing are not refused:

- **Server-managed fields**: `created_at`, `updated_at`, `namespace`,
  `api_spec_id`. `updated_at` in particular moves on writes this editor is not
  competing with.
- **Fields the write never replaces.** A proxy save omits `plugins`, and Edge
  keeps the live associations when the key is omitted, so a membership change
  from the plugin pages cannot be lost by a proxy save and is not a conflict.
  Upstreams also exclude the mesh-projected fields the control plane owns.

The upstream **targets** editor replaces only `targets`, so its guard compares
only `targets`. `upstreams.updateTargets` is designed to compose with a
settings save from the same client, and comparing the whole upstream would turn
that into a conflict. A concurrent change to the targets is still refused,
which is the only thing that write can lose.

## Which writes are guarded

| Write | Compared against | Conditional on |
| --- | --- | --- |
| Proxy settings save | the editor's seed, every field except `plugins` (never sent) | the verification read |
| Upstream settings save | the editor's seed, minus mesh-projected fields | the verification read |
| Upstream targets save | the `targets` the add/edit form was opened against (for a row removal, the list on screen when it was clicked) | the read its settings are rebuilt from |
| Consumer Details save | the editor's seed, minus `credentials` and `labels` (never sent) | the read its credentials are taken from |
| Consumer ACL add/remove | the consumer the group list was computed from | the read its credentials are taken from |
| Plugin configuration save | the editor's seed, minus `labels` (never sent) | the membership plan's fresh read |
| MCP tool policy save (proxy page, MCP Tools tab) | the one `config.policy.tools` entry the edit was opened against (for a new entry, its absence) | the read every other field is rebuilt from |
| Proxy, upstream, consumer, or plugin delete from its detail page | the resource the page is displaying | the verification read |
| Every write inside a plugin membership plan | the plan's own `updated_at` preflight | the read that preflight compared |

### Consumers

A consumer `PUT` replaces the stored credential types even when the body omits
`credentials`. So a metadata save takes the credentials from a fresh read
inside the consumer write queue ([client-recovery.md](client-recovery.md)).
That read is also the guard's verification read, and the `PUT` carries its
tag. If a rotation lands after the read, the gateway refuses the write instead
of restoring the old credentials. The guard re-reads, finds the metadata
unchanged, and re-sends with the rotated set. Credentials are not compared: a
metadata draft cannot revert a rotation, and `[REDACTED]` markers say nothing
about what changed.

Neither the Details form nor the ACL editor sends `labels`, and Edge keeps the
stored map when a `PUT` omits it. A label set by a provisioner cannot be
reverted by these saves, so `labels` is not compared, for the same reason as
`plugins` on a proxy. Plugin configuration saves omit and exclude `labels` the
same way.

### Plugin configurations and membership plans

A plugin save runs through the membership plan (`src/lib/pluginMembership.ts`),
which re-reads every resource it writes and refuses if its `updated_at` moved
since the plan's preflight. On top of that:

- **Every write in the plan is conditional on the read it is based on.** It
  sends that read's tag as `If-Match` (`validatorOf` in
  `src/api/conditionalWrite.ts`), so each read-compare-write step is atomic and
  also catches a change that did not move `updated_at`. A `412` is reported as
  the plan's own "changed during membership preflight" refusal, or during
  rollback as "changed after Foundry updated it; … was not overwritten".
- **The plan checks the editor's baseline.** A configuration that changed since
  the editor opened is refused with `StaleResourceError` at the preflight read,
  before any association is touched, and again at the read the plugin `PUT` is
  conditional on. If that `PUT` gets a `412`, the plan re-reads once more so a
  now-stale draft shows the comparison instead of a generic failure.

### MCP tool policy

The MCP Tools tab on a proxy edits one `config.policy.tools` entry of an
`mcp_gateway` configuration at a time (`updateToolPolicy` in
`src/api/mcpTools.ts`). Like a targets save, it owns only that entry: every
other field comes from a fresh read, the guard compares just the entry the
operator was looking at (`toolPolicyWriteGuard`), and the `PUT` carries that
read's tag. A concurrent change to another tool, a server, or the scope is
carried over on the re-sent write; a concurrent change to the same entry, or a
new entry someone else already wrote, is refused with the comparison. The save
omits `labels`, so a `provisioned-by` attribution is preserved, and it is
refused before sending when the read masks a value for the session's role
(`MaskedSecretWriteError`), because resending the placeholder would be refused
by Edge v0.9.9 (an `admin`, whose reads are raw, is never refused). It does not
go through the membership plan: it never changes scope or associations.

### Deletes

A delete from a detail page is checked against the resource the page is
showing when the operator confirms, not against the form's seed, so the
operator's own earlier saves (for example from the Targets tab) never block
their delete. If another writer changed it, the delete is refused and
`StaleWriteDialog` shows what moved, with no draft column and no "delete
anyway". A plugin delete checks before detaching any proxy and again at the
read its final `DELETE` is conditional on.

## Committed but not yet live

Edge answers a proxy, upstream, or consumer `PUT` or `DELETE` whose row
committed, but which the in-process reload could not make live, with `503` and
either a valid `X-Ferrum-Config-Cursor` or a body with `applied: false` (the
"committed but not live" case of `NamespaceAdmissionUnavailable` in Edge's
`openapi.yaml`). A `503` where nothing was applied has no `applied` field and
no cursor. The row is durable; only the live apply is behind.

`committedNotLiveAnswer()` (`src/api/gatewayMetadata.ts`) is the single
predicate for this. The live-apply monitor, restore, and the API client all use
it. For a configuration write, the client's `beforeError` hook marks the
rejection as a **committed write** (`getCommittedWrite()` in
`src/api/client.ts`, which follows the `cause` chain like
`isUnobservedWrite()`). Then:

- **No error popup.** The live-apply banner already shows "Committed, not yet
  proven live" and monitors the cursor, or reports a commit without a valid
  cursor as unverifiable. `getApiErrorMessage()` uses the same wording, never
  "Failed to …".
- **Cached reads are refreshed.** The `MutationCache` (`src/lib/queryClient.ts`)
  invalidates on a committed write just as on an unobserved one. The proxy,
  upstream, and consumer update hooks also refresh the resource's detail and
  list before the caller sees the outcome, as their `onSuccess` does.
- **Nothing is resent.** The retry policy never retries a committed `503`, even
  on a read.

### The decision: reseed, do not adopt

A save that commits must move the baseline. Otherwise the next Save re-reads
the gateway, finds the operator's own change, and refuses it as a concurrent
edit. Only one way of moving it keeps the rule that the baseline always
describes what the form is showing:

| Option | Outcome |
| --- | --- |
| Keep the old baseline | The next Save is refused with `StaleResourceError` listing the operator's own change. |
| Adopt the draft payload | A payload is not a canonical representation (it spells a cleared field as `null` where a read omits the key), so it never matches the stored resource and the next Save is refused anyway. |
| Adopt a fresh read, keep the form's fields | A writer that committed between the save and that read would be adopted into the baseline while the form still shows this operator's values, and the next Save would silently revert it. |
| **Reseed form and baseline from one fresh read** | **Chosen.** Both come from the same read, so the baseline never describes content the form is not showing. The draft is not lost: it is what the gateway now holds. A writer in the gap is shown, not overwritten. |

`reseedAfterCommit()` (`src/hooks/useEditBaseline.ts`) does this for the proxy,
upstream, and consumer detail forms. It is the same refetch-and-remount as
"Discard my draft and reload", run automatically because the draft was
committed. The toast reads "Proxy saved: committed, not yet proven live" and
points to the live-apply banner. If that read fails, nothing moves: the form
keeps the draft, the toast says to reload before saving again, and a further
Save is judged against the old baseline.

The two single-field editors take their guard from the list they were computed
from rather than the settings form's seed. The update hooks refresh the
resource before the rejection reaches them, so an upstream **targets** save or
a consumer **ACL** change that commits closes its editor like a success, and
the next edit starts from the committed list.

#### Upstream target forms

A target add or edit form holds a draft, so it is seeded once too. Opening it
captures the target list on screen and the guard built from it, and the new
list is computed from that capture. A background refetch that brings a
concurrent target change updates the rows on screen but not the open form's
basis, so its save is refused instead of being approved against a list the
draft was not edited from. Only `targets` is compared, so a settings change in
the same refetch still composes. "Discard my draft and reload" from a targets
refusal closes the target form and leaves any settings draft alone.

The open form and its captured list are one piece of state: dropping the draft
closes the form, and a save handler that finds no draft reports an error. An
edit form is bound to its target's identity (`host:port` plus how many earlier
targets share that address, `targetIdentities()` in
`src/lib/upstreamTargets.ts`), not to a row position, so rows shifting after a
refetch or removal neither remount the form nor move it to another target. If a
refetch no longer lists the target, the form stays open with a notice, and its
save is refused with the comparison.

A row removal on the same page moves an open form's basis only if the form was
opened against the exact list the removal was computed from, and only onto a
result known to be stored: the gateway's answer, or, when the removal answered
committed-but-not-live, a fresh read whose `targets` match the list the removal
wrote. A read that differs may include another writer's change, so the form
keeps its old basis and its save is refused.

A cached-config read (`X-Data-Source: cached`) can lag the commit, and the form
would then show older content. That is the same exposure as seeding an editor
from such a read: the next Save is refused if its verification read comes from
the database, and falls back to [Without a tag](#without-a-tag) if that read is
cached too. The cached-data banner is shown either way.

### Committed deletes

A committed delete **is** a completed delete. `removeCommitted()`
(`src/hooks/retireDeletedDetail.ts`) resolves the proxy, upstream, and consumer
delete mutations with `committed` set instead of rejecting them. Their
`onSuccess` then retires the cached detail entry and invalidates the lists
(and, for a proxy, the cascade) exactly as for a `204`, and the page leaves
with "Proxy deleted: committed, not yet proven live".

### Committed credential writes

A consumer credential append, basic replacement, indexed delete, or delete of
all basic credentials that commits is also a completed write. The credential
hooks (`writeCredential()` in `src/hooks/useConsumers.ts`) resolve with
`committed` set and refresh the consumer as for a `2xx`. The credential card
completes: the secret is shown once in the copy-once receipt, the draft is
cleared, the form closes, and the card shows a "committed, not yet proven live"
line until the operator's next credential action. This keeps a second click
from appending the same secret again.

A credential write whose answer was lost may also have committed. The hook
records the consumer revision when the lost answer arrives, re-reads the
consumer, and rejects with `UnobservedCredentialWriteError` carrying that
revision. The card keeps the draft (it may be the only copy of a stored
secret) but refuses any add or replacement until a read newer than that
revision has arrived. It does not use the revision the form rendered at submit
time, because a refetch during the write could already have passed it. A
second add is also refused while one is in flight, checked synchronously so a
double submit cannot write twice.

The re-read cannot confirm the credential is there: secrets are listed as
`[REDACTED]` and basic credentials are not listed at all. For a key, JWT, or
HMAC add, the card compares the count before and after and says the credential
was *likely* stored (or likely not). For a basic add it says presence cannot be
observed and points to "Replace basic credentials", which is safe to repeat but
revokes every existing basic password. This "outcome unknown" line survives
Cancel and reopening the form, and clears only when a later add, replacement,
or delete of all basic credentials from the card completes. Deleting one listed
credential does not clear it; if that entry was listed before the add, the
recorded count drops by one so the comparison stays valid. Only a read strictly
newer than the recorded revision re-arms the form.

An indexed delete whose answer was lost closes its confirmation, since the
index may now point at a different credential. No failure rethrows the ky
error, which holds the secret-bearing request. A definite rejection becomes a
plain error carrying the gateway's detail, with every submitted value replaced
by `[REDACTED]` throughout the parsed body (every string, keys included, in
raw, JSON-escaped, and trimmed forms) before the detail is extracted. This
matters because extraction trims each field and cuts it to 600 characters, and
a shortened echo would no longer match the submitted value. An append opts out
of the global error popup, which would show the raw gateway body.

### Every other secret-bearing write

The same redaction (`src/api/secretRedaction.ts`) covers every write whose body
carries a secret: consumer create, plugin configuration create and update
(including a membership plan's rollback), upstream create and update, managed
TLS and ACME certificate writes, ACME order creation and renewal, TLS
validation, batch create, backup restore, and API spec import and replacement.

`secretValues()` finds secrets by position, not by resource type:

- every string under a credential-shaped field name at any depth (the conflict
  dialog's `isRedactedField` list, plus `headers` maps, webhooks,
  service-account documents, and camelCase `*Key` fields);
- the userinfo, path, query, and fragment of any URL (a bare
  `scheme://host[:port]` stays readable);
- each line of 16 characters or more of a multi-line value such as a PEM key,
  since a parser that rejects one line quotes that line. PEM armor lines
  (`-----BEGIN CERTIFICATE-----`) stay readable.

**Plugin `config`.** A plugin configuration's `config`, in a plugin write or a
batch entry, is classified the way Ferrum Edge projects it for a non-admin read
(`src/admin/plugin_config_projection.rs`), so nothing Edge hides from a read can
come back in a refusal. `PLUGIN_SENSITIVITY` transcribes Edge's per-plugin
rules (for example `ai_semantic_cache`'s `semantic_embedding_auth_header`,
`proxy_alerts`' `channels.*.body_template`, `api_chargeback_sink`'s
`clickhouse.insert_query_params.*`, and every `kafka_logging` `producer_config`
property not on Edge's safe list, such as `ssl.key.pem`). Edge's name and URL
rules apply beneath them. A plugin the table does not name (a custom plugin, or
a built-in newer than the paired release) has no rules, so every string in its
`config` is treated as secret. Edge's operator-configured
`FERRUM_LOG_REDACT_METADATA_KEYS` are not visible to Foundry.

The table lives in `src/api/pluginSensitivity.ts`, with the Edge commit it was
checked against in `PLUGIN_SENSITIVITY_SOURCE`. The Pinned Gateway Contract job
runs `scripts/plugin-sensitivity-drift.mjs`, which fetches
`plugin_config_projection.rs` at `edge.source_commit`, parses
`PLUGIN_SENSITIVITY_SCHEMAS` and `KAFKA_SAFE_PRODUCER_PROPERTIES`, and fails on
any plugin or rule that differs or that it cannot parse. Its unit test fails
when the recorded commit is not the pinned one.

**Restore and API specs.** `restoreSecrets()` is `secretValues()` over the
backup plus each API spec document it holds (gzip-compressed, base64-encoded,
and taken whole). For an API spec import or replacement, `specDocumentSecrets()`
classifies a JSON document by position: each `x-ferrum-plugins` entry by its
plugin's rules, anything else by field name and URL. An entry that is not a
plugin configuration is unclassified throughout. Foundry has no YAML parser, so
a YAML (or malformed JSON) document is unclassified throughout: every scalar is
found line by line without parsing, including `key: value` values, sequence
entries, flow elements, quoted scalars (unquoted and unescaped), several pairs
on one line, and keys with no space before the value (`"api_key":"…"`). A
double-quoted scalar continued with a trailing `\` is recorded both line by
line and joined. A second scan starts on every line, so a stray quote in a
comment or block scalar cannot put the scan out of step. A key-only line is
skipped except inside a block scalar (`key: |`, `- |`), where every line is
content. Both surfaces report their own failures (`SILENT_ERRORS`), and a spec
write's unknown outcome keeps only the redacted error as its `cause`.

**Short values.** A value that is secret only because nothing classifies it
(every string of an unknown plugin's config, every YAML scalar) is redacted
wherever it appears when it is 8 characters or longer. A shorter one (`a`,
`on`, `error`) also appears in ordinary words, error-body keys, and the
`[REDACTED]` marker itself, so it is redacted only as a whole token of a string
value. A classified value is redacted wherever it appears in a string value,
whatever its length. No value shorter than 8 characters, classified or not, is
matched in the body's structure: object keys and the top-level `code`,
`phase`, `rollback`, `failure_class`, and `confirmation_required` fields (a
nested field with the same name is redacted in full). So a restore whose backup
holds a credential such as `api`, `ro`, or `true` still gets a recognizable
`api_specs_at_risk` confirmation, rollback outcome, and upload-phase timeout.
All matches are found in the original text and replaced in one pass, with
overlapping matches merged into one marker.

**`withRedactedFailure()`** replaces any failure of such a write with a
`RedactedWriteError`: the redacted message, the original error's `name`
(`HTTPError`, `TimeoutError`, `UnboundNamespaceError`), a bodiless copy of the
response (status and headers), and the redacted parsed body as `data`, with no
`request`, `options`, or `cause`. `getApiErrorDetail()`,
`isPreconditionFailed()`, and the outcome classifiers read it like a ky
`HTTPError`, and the committed-write and unobserved-write markers carry over, so
`412` handling, "committed, not yet proven live", and "outcome unknown" behave
the same.

The global error popup is raised from ky's own error, before redaction runs, so
each such request carries `REDACT_ERRORS`. The client holds the report, and
`withRedactedFailure()` raises it once the secrets are removed, with the same
status, URL, and outcome. A write whose answer was lost still opens the
"Outcome unknown" dialog ([client-recovery.md](client-recovery.md)). A failure
the popup never reports (a committed write, a guarded save's handled `412`) is
not held. Writes whose form reports every refusal itself (consumer credential
writes, managed TLS create, ACME order creation and renewal, TLS validation)
use `SILENT_ERRORS` instead. A plugin membership plan includes the gateway's
redacted reason in its own message.

Every secret-bearing mutation hook, including restore and API spec import and
replacement, sets `gcTime: 0`, so the submitted body does not stay in the
mutation cache after the form is gone. Consumer metadata saves are not wrapped:
their body carries no submitted secret, because the credentials in it come from
a read where they are already `[REDACTED]`.

## What the operator sees

`StaleWriteDialog` opens when a save or delete is refused. For a save:

1. **The draft survives.** Nothing from it was written. "Keep my draft" closes
   the dialog and returns to the unsaved changes.
2. **There is no automatic reapply and no "save anyway".** Resending the same
   body against the newer version *is* the overwrite the guard refused. The
   operator re-applies their edit against current content. "Discard my draft
   and reload" is the only other option, and it remounts the editor from a
   fresh read rather than rebasing dirty fields.
3. **No secrets on screen.** Values are rendered through `formatBaselineValue`,
   which shows credential-shaped values as `[redacted]` while still showing
   that the field changed. A `*_path` field is shown, since a path to material
   is not the material. Nothing from the comparison is written to browser
   storage, telemetry, or logs.

### The writer can be this operator

The upstream settings form also holds `targets`, seeded once like every other
field. After a save from the Targets tab, the settings form still has the old
list, so saving it would revert the target change. The guard refuses it, and
the dialog says the resource changed after the editor opened, not that
"someone else" changed it, because the other writer may be this same page.
Discard and reload picks up the new targets.

## Baselines and background refetches

The baseline follows the same seed-once rule as the form fields
(`src/lib/editorIdentity.ts`): it is taken from the first successful read for
an editor identity and is **not** advanced by background refetches. Adopting a
newer refetch would let the guard pass while the form still held older values,
which is exactly the silent rebase this mechanism prevents. Only three things
move a baseline:

- a response the gateway just accepted from this editor;
- an explicit discard and reload;
- the reseed after a committed-but-not-live save.

A namespace switch or a route change to another resource remounts the editor,
so the next successful read seeds a fresh baseline.

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

`scripts/mock-admin-gateway.mjs` implements the same contract: a tag on item
`GET`, `412` on a stale `If-Match` for `PUT`/`DELETE`, `404` before the
precondition, strong comparison, and `400` for a malformed header or for
`If-Match` on any other mutating route. The conflict dialog can be exercised
without a gateway. Its tag is an unkeyed digest; Edge keys its tag so it cannot
be used to test guesses of a redacted value.

## Still open

- **The cached-config fallback.** A read served from Edge's cached
  configuration (`X-Data-Source: cached`) has no tag, so a write verified
  against it is sent unconditionally and the race is narrowed to one round
  trip rather than closed. This is Edge's contract: a tag cannot be issued from
  a cache that may lag the database.
- **A browser-level two-session journey.** Not yet in the critical-journey
  suite (`e2e/journeys`).
