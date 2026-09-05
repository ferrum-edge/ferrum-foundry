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

A 503 with `applied: false` and `X-Ferrum-Config-Cursor` identifies committed
configuration that is not yet proven live. It is never retried, even if received
on a read. Foundry monitors the cursor through read-only apply-status requests;
it does not resubmit the mutation. Runtime rejection or unavailable status needs
inspection of the gateway configuration and runtime logs before another change.
The live-apply banner's statement that the request was not replayed is enforced
by the shared retry policy, independently of metadata observation and error
popup suppression.

Configured-client tests in `src/api/client.retry.test.ts` inject fetch failures
and count actual requests, including the surviving credential rotation entry.
GitHub-hosted CI runs these tests together with the existing frontend suite.
