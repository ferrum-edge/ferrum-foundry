# Client retries and write recovery

The shared HTTP client in `src/api/client.ts`, including its `proxyApi` instance,
automatically retries only GET, HEAD, and OPTIONS. Each HTTP call allows at most
two retries (three requests total) for the existing 408, 413, 429, 500, 502, 503,
and 504 status policy. ky retains its backoff and Retry-After handling for reads
(413 requires a retry timing header), and its default network-error handling.
Query refetches and bounded apply-status polling are separate read operations.

POST, PUT, PATCH, and DELETE are never automatically replayed, including on
network failures and responses with Retry-After. There are no write exceptions:
even a full-replace PUT can have committed before its response fails. Any future
exception would need a documented operation-specific idempotency contract and
proof that replay cannot repeat a committed side effect. An indexed credential
DELETE must never be retried automatically: after removing index 0, the other
rotation entry shifts into that index.

Write failures reject to the caller. A 502 or lost connection does not prove
that nothing changed. Re-check the resource with a fresh read, inspect its current
state, and decide whether another edit is needed. For credential deletion,
refresh the consumer and select the intended remaining credential again; do not
resubmit an index from the stale rotation list.

A 503 with a valid `X-Ferrum-Config-Cursor` identifies committed configuration
that is not yet proven live, even when its body is missing, malformed, or does not
contain the boolean `applied: false`. A body with `applied: false` but no valid
cursor is committed but unverifiable. It is never retried, even if received
on a read. Foundry monitors the cursor through read-only apply-status requests;
it does not resubmit the mutation. Runtime rejection or unavailable status needs
inspection of the gateway configuration and runtime logs before another change.
The live-apply banner's statement that the request was not replayed is enforced
by the shared retry policy, independently of metadata observation and error
popup suppression.

Configured-client tests in `src/api/client.retry.test.ts` inject fetch failures
and count actual requests, including the surviving credential rotation entry.
GitHub-hosted CI runs these tests together with the existing frontend suite.

Consumer Details and ACL updates never reuse the editor's credential snapshot.
The client serializes consumer and credential writes by namespace and consumer
id, then reads the current credential projection immediately before a metadata
PUT. This is required because the gateway's consumer PUT is a full replacement:
omitting credentials can remove represented credential types. A failed fresh
read prevents the PUT. A failed write releases the queue without replaying it.
This queue coordinates one client instance; it cannot make GET/PUT atomic against
other browsers or external writers without a gateway conditional-write contract.

After a metadata write, the accepted consumer seeds its namespace-specific query
cache and the editor remains pending through refetch. Subsequent ACL changes use
that accepted group list. A credential-list refresh invalidates an open indexed
delete selection, even when redacted entries look identical; select it again
before confirming. Namespace/consumer changes still discard the entire editor.

Upstream target edits also read the latest upstream before their full-replace
PUT and change only `targets`. Settings, target, and delete writes share a
namespace/upstream queue, so target updates preserve health checks, service
discovery, subsets, and TLS accepted by an earlier Settings save. The accepted
upstream seeds its scoped cache and editing stays pending through reconciliation.
As with consumers, this client queue cannot protect against external writers
without a gateway conditional-write contract.

Live-apply response ownership is allocated when a gateway mutation is dispatched,
before its headers arrive. A delayed older response or body cannot replace the
newest started mutation's result. Starting a write clears a previous terminal
success, but preserves a known committed change that still needs inspection.
A later non-committing 4xx or 5xx leaves that monitor running; the ordinary error
surface reports the failed write. A newer committed result retires the old poll.

The banner always names its originating namespace (or Fleet-global) and request
path, even after the selected namespace changes. Status responses must contain a
recognized state and valid uint64 cursor fields matching the requested cursor;
an applied result must also prove acceptance of that sequence in the same epoch.
Malformed responses become visibly unverifiable. Pending monitoring is bounded
to eight reads; exhaustion leaves the cursor visible with “Monitoring ended”
copy. Authentication or grant changes clear metadata and invalidate older in-flight
responses and polls. Configured-client coverage exercises delayed headers, reused
request options, failed writes during monitoring, malformed envelopes, namespace
labels, and session boundaries in GitHub-hosted CI.

Consumer creation and credential append retain submitted API keys, JWT/HMAC
secrets, and Basic auth passwords in a one-time copy panel after success. The
panel uses the submitted values, never a redacted response. Saving with secrets
pauses navigation until “I have saved these credentials”; appending clears the
entry form and keeps the copy panel until that acknowledgement. A failed write
keeps the editable input and does not claim a successful credential save.
Clipboard failure leaves the value available for manual copying.

The copy panel lives only in the mounted editor. A namespace change, navigation,
or logout discards it. Nothing from that panel is written to browser storage or
query data; completed create/append mutation state is reset and has zero inactive
cache retention. Later gateway reads continue to redact secrets or omit Basic
auth credentials. Copy secrets to an appropriate credential store before leaving
this view; Foundry cannot recover them afterward.
