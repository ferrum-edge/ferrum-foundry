# Client retries and write recovery

A failed write may already have committed. Foundry therefore never replays a
write automatically, and when it cannot tell whether a write committed it says
so instead of guessing.

## Retries

The shared HTTP client (`src/api/client.ts`, including its `proxyApi`
instance) retries only `GET`, `HEAD`, and `OPTIONS`:

- at most two retries (three requests in total) per call;
- only for `408`, `413`, `429`, `500`, `502`, `503`, and `504`, plus ky's
  default network-error handling;
- with ky's backoff and `Retry-After` handling (`413` needs a retry timing
  header).

Query refetches and apply-status polling are separate read operations.

`POST`, `PUT`, `PATCH`, and `DELETE` are never replayed, not on network
failures and not on a `Retry-After`. There are no exceptions: even a
full-replacement `PUT` can commit before its response fails. An exception would
need an operation-specific idempotency contract that proves replay cannot
repeat a committed side effect. An indexed credential `DELETE` in particular
must never be retried: after index 0 is removed, the other rotation entry moves
into that index.

A failed write rejects to the caller. A `502` or dropped connection does not
prove nothing changed. Re-read the resource, check its state, and decide
whether another edit is needed. For credential deletion, refresh the consumer
and select the remaining credential again; never resubmit an index from the
old list.

`src/api/client.retry.test.ts` injects fetch failures into the configured
client and counts the requests actually sent.

## Committed but not yet live

A `503` with a valid `X-Ferrum-Config-Cursor` means the configuration committed
but is not yet proven live, even if the body is missing, malformed, or lacks
`applied: false`. A `503` body with `applied: false` but no valid cursor is
committed but unverifiable. Neither is ever retried, even on a read. Foundry
monitors the cursor with read-only apply-status requests and does not resubmit
the mutation. If the status reports a runtime rejection or is unavailable,
check the gateway configuration and runtime logs before making another change.
The live-apply banner's "not replayed" statement is guaranteed by the retry
policy itself, independently of the banner and popup logic.

On a configuration write this answer is a **committed write**, not a failure.
The client marks the rejection (`getCommittedWrite()`), shows no error popup
(the banner already reports it), and the `MutationCache` refreshes cached reads.
`getApiErrorMessage()` says the change was saved but is not yet proven live. A
proxy, upstream, or consumer detail editor reseeds its form and write-guard
baseline from a fresh read, so the next Save is not refused as a conflict with
its own commit. A committed delete resolves as a delete and retires its cached
detail. See
[concurrent-edits.md](concurrent-edits.md#committed-but-not-yet-live).

## Write queues

**Consumers.** Consumer Details and ACL saves never reuse the editor's
credential snapshot. The client serializes consumer and credential writes per
namespace and consumer id, and reads the current credentials immediately before
each metadata `PUT`. This is needed because the consumer `PUT` is a full
replacement: omitting credentials can remove stored credential types. If the
fresh read fails, the `PUT` is not sent. A failed write releases the queue
without replaying.

After a metadata write, the accepted consumer seeds its namespace-specific
cache, and the editor stays pending through the refetch. Later ACL changes use
that accepted group list. A credential-list refresh cancels an open indexed
delete selection, even when the redacted entries look identical; select the
credential again before confirming. A namespace or consumer change discards the
whole editor.

**Upstreams.** Target edits also read the latest upstream before their
full-replacement `PUT` and change only `targets`. Settings, target, and delete
writes share one queue per namespace and upstream, so a target update keeps the
health checks, service discovery, subsets, and TLS saved by an earlier Settings
save. The accepted upstream seeds its cache, and editing stays pending until it
is reconciled.

These queues coordinate one client only. Against other browsers and external
writers, the editor's baseline guard sends `If-Match` from a fresh read; the
targets editor's guard compares only `targets`, so this client's own
settings-then-targets sequence still works. See
[concurrent-edits.md](concurrent-edits.md).

## Live-apply banner

Response ownership is assigned when a gateway mutation is sent, before its
headers arrive, so a delayed older response cannot replace the newest
mutation's result. Starting a write clears a previous success but keeps a known
committed change that still needs attention. A later `4xx` or `5xx` that did
not commit leaves that monitor running, and the ordinary error surface reports
the failed write. A newer committed result replaces the old poll.

The banner always names its originating namespace (or Fleet-global) and request
path, even after the selected namespace changes. A status response must contain
a recognized state and valid uint64 cursor fields that match the requested
cursor, and an applied result must also prove the sequence was accepted in the
same epoch. Anything malformed is shown as unverifiable. Monitoring stops after
eight pending reads and leaves the cursor visible with "Monitoring ended".
Authentication or grant changes clear the banner and invalidate older in-flight
responses and polls.

## Credential copy panel

Consumer creation, credential append, and basic credential replacement keep the
submitted API keys, JWT/HMAC secrets, and Basic auth passwords in a one-time
copy panel after success. The panel uses the submitted values, never a redacted
response.

- Saving with secrets blocks navigation until "I have saved these
  credentials" is acknowledged. An append clears the entry form and keeps the
  panel until acknowledged.
- A failed write keeps the editable input and does not claim success.
- If copying to the clipboard fails, the value stays available to copy by hand.
- The panel exists only in the mounted editor. A namespace change, navigation,
  or logout discards it. Nothing from it is written to browser storage or query
  data, and finished create, append, and replace mutations are reset with no
  cache retention.

Later gateway reads redact secrets and omit Basic auth credentials, so copy
secrets to a credential store before leaving the view. Foundry cannot recover
them afterward.

### Basic auth

The [Ferrum Edge admin API](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
omits the whole `basicauth` type from ordinary consumer responses, whether or
not passwords exist. The Basic Authentication card therefore always shows
presence and count as unknown:

- **Add** appends a password.
- **Replace basic credentials** replaces every existing basic password with
  the submitted one.
- **Delete all basic credentials** removes the whole type after confirmation.

The login identity is the consumer's username; no credential-level username is
sent. Replacement failures use a generic message so echoed passwords and
request objects are not kept in mutation errors. Completion refreshes only the
originating namespace and consumer, and cannot fill another editor's copy panel
or close its dialog.

Effective policy treats basic-auth credentials as unobservable. When no other
matching credential is observed, access is shown as conditional with a reason.
Explicit ACL denials still apply. Observed matching credentials keep their
normal decisions, including request triggers, external identity mapping, and
unknown execution order. Pure key-auth policies still distinguish observed
credentials from missing ones. Foundry never reads backup secrets to decide
access. The pinned-gateway smoke test checks, with disposable synthetic
credentials, that ordinary responses omit basic credentials and that backup
hashes are canonical.

## Unknown outcomes

Some write failures carry no answer from the gateway, so Foundry cannot know
whether the change committed. `classifyUnobservedOutcome()` in
`src/api/mutationOutcome.ts` classifies them for ordinary writes and for
restore. The BFF's `phase` decides:

| Failure | Classified as |
| --- | --- |
| `504 FERRUM_BFF_TIMEOUT` with `phase: "upload"` | Definite failure: the body never finished uploading, so the write did not run |
| `504` after the body was sent (`phase: "response"`, or no BFF body) | Unknown outcome (`gateway_timeout`) |
| `502 FERRUM_BFF_UPSTREAM_FAILURE` | Unknown outcome (`upstream_failure`) |
| ky `TimeoutError` | Unknown outcome (`client_timeout`) |
| A dropped connection or other rejection after sending | Unknown outcome (`transport`) |
| `UnboundNamespaceError` | Not a write outcome: refused before anything was sent |

Any other status is the gateway's own answer and is handled normally,
including the `503` cases above. The admin API has no operation id or
idempotency key, so the ambiguity is reported, not resolved.

For an ordinary configuration write, the client's `beforeError` hook
classifies the rejection before any popup opt-out, so a `SILENT_ERRORS`
caller's write is reported the same way:

- The live-apply banner shows **Outcome unknown — this change may have
  committed**, with the cause, namespace, request path, and a note that the
  request was not replayed. It never says the change did not commit. It clears
  when the next write starts, and it never displaces a pending, rejected, or
  unverifiable monitor for a known commit; the error dialog still reports the
  newer write.
- The error dialog is titled **Outcome unknown** instead of "API Error" and
  keeps the status, URL, and BFF code. Forms that show their own error through
  `getApiErrorMessage()` get the same wording instead of "Failed to …".
- The `MutationCache` (`src/lib/queryClient.ts`) invalidates cached reads so
  the operator decides from real gateway state. The form keeps its draft.
- Nothing is resubmitted. That guarantee comes from the retry policy, not from
  this classification.

Operations that wrap the rejection (for example `observeMutation()` for TLS and
API spec writes) are still recognized through `isUnobservedWrite()`, which
follows the `cause` chain.

The browser journey `e2e/journeys/interrupted-write.spec.ts` lets a create
commit on the real gateway, drops its response, and checks that the unknown
outcome is shown, the draft survives, and exactly one resource exists.

## Restore

Restore handles `503` answers the same way: a valid commit cursor or
`applied: false` shows a "Restore committed" warning, clears the restore
confirmation, and refreshes cached reads. The live-apply banner monitors a
valid cursor; a commit without a valid cursor stays unverifiable.

Because detail editors seed once, "refresh" after a restore means *retire*.
The restored namespace's proxy, upstream, consumer, plugin configuration, and
API spec detail entries, and its inactive lists of those kinds, are removed
rather than invalidated; every other read is invalidated. This happens after a
success, a committed-but-not-live answer, an unknown outcome, and every `5xx`
failure except one that proves the namespace unchanged: a rollback that
`completed` or was `not_needed`, a `connectivity` failure class, or the BFF's
upload-phase timeout.

For unknown outcomes, an upload-phase `504` stays on the ordinary retryable
path with the confirmation still armed. Any other unknown outcome may already
have replaced the namespace, so restore shows an "outcome unknown" panel that
names the cause and clears the loaded backup, so the destructive action is no
longer one click away. The same backup can be restored again with an explicit
"Re-arm this restore" action.

Connectivity failures before commit keep the gateway's `restore_errors` and
`failure_class` in the recovery panel. The typed confirmation for a restore that
would delete API specs, and `500` rollback outcomes, have their own handling. Foundry never
resubmits a restore automatically.

## Error notifications

The global error dialog reports terminal failures only. Direct HTTP calls
notify from ky's final-error hook after the retry budget is used up. Query hooks
pass `queryScope(scope)` (or `QUERY_ERROR_CONTEXT` for fleet-global reads), so
their errors wait until TanStack Query emits its final `error` event.
Intermediate retry failures never open a dialog. A permanently failing read can
still make four Query attempts of up to three HTTP requests each.

Deferred details are attached to the rejected `Error` and consumed once, so
several observers do not duplicate a notification. A success does not dismiss
an unrelated error. `SILENT_ERRORS`, optional feature probes, and locally
interpreted readiness and occupancy checks stay quiet but keep their normal
result or rejection. New query functions must pass the query notification
context through every page and follow-up read. HTTP error data stays available
to forms after ky consumes the response body.
