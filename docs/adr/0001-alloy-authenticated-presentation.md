# ADR 0001: Authenticated presentation of Alloy-produced data

Status: accepted for the unreleased Foundry boundary. Manifest preview is
implemented; diagnostic presentation and telemetry/report import are future
work tracked by [Alloy issue 27](https://github.com/ferrum-edge/ferrum-alloy/issues/27).

## Context

Alloy is a local service/CLI producer of a shared service manifest and
diagnostic evidence. It is not a trace store or an authenticated Foundry data
plane. Foundry already authenticates sessions behind its BFF, authorizes exact
namespace grants and signs gateway calls as the principal. Browser-direct
admin/management access or authorization based on a document's namespace would
bypass that boundary.

## Decision

Foundry presents gateway- or service-produced diagnostic data only through an
authenticated, namespace-authorized BFF. The principal's grants and an explicit
request binding authorize the lookup; producer-supplied namespace claims,
trace IDs, service names and references are untrusted metadata. Reuse the
existing trusted-proxy or development-session identity, role and CSRF boundary.
Do not add an auth mode or open Alloy management ports. A viewer can review data
that the authoritative producer permits it to read; read denial remains denial,
not an empty collection, and missing/unavailable evidence remains unknown.

Any future diagnostic presentation must use a fixed allowlist of authoritative
gateway/service routes with a deployment-controlled target. The browser supplies
bounded typed references, never a URL, filesystem path, forwarded credential or
arbitrary query. The BFF verifies namespace access before parsing or initiating
a producer query and propagates the authenticated principal using the approved
producer's authentication contract. It must not proxy generic Alloy management
traffic, synthesize verified identity from a report, or fall back to another
tenant when a producer denies access.

Future lookup implementation must make concrete budgets part of its route:
at most 4 KiB serialized query, one authorized namespace, 100 returned records,
64 KiB response bytes **before** parse, nesting at most eight levels, and a
five-second absolute deadline with cancellation and admission limits. Pagination
or another producer fetch must consume the same budget; incomplete evidence
cannot become a complete conclusion. This ADR proposes those limits; no
diagnostic route enforces them yet. Adjusting them requires reviewed evidence
from the producer and consumer rather than unrestricted pass-through.

Redact credentials, key material and sensitive endpoint components before
logging, error truncation, caching or sending a diagnostic response. Present
only reviewed field projections with bounded strings and fixed failure codes;
error text is at most 256 bytes and contains no raw producer body or submitted
values. No credential-bearing browser storage. Do not retain raw telemetry,
introduce a Foundry trace database or make Alloy a trace store. Future retention,
if necessary, is a separately reviewed storage and access decision.

## Implemented slice

The [service manifest preview](../alloy-manifest-preview.md) is a submitted,
bounded JSON document checked against the exact shared contract and reviewed
Alloy producer rules. Its authenticated BFF route is read-only for every role,
requires a matching authorized namespace, makes no upstream call and returns
only desired resource fields and an informational summary. TLS paths are
redacted metadata and are never read. No manifest URL or OpenAPI file is loaded.
There is no telemetry ingestion, report importer, diagnostic lookup, trace
query, persistent plan or automatic gateway application in this implementation.

The published `contracts-edge-0.9.11` metadata marks the shared manifest and
diagnostic report EXISTING/implemented after root's accepted owner/consumer
qualification. Foundry adopts the exact manifest schema and fixtures, with
owner-unreleased availability and historical descriptions retained. Alloy crate
publication and remaining coordinated adoption are separate decisions tracked
by issue 27; diagnostic presentation stays future work here. Normal resource
editor saves are separately approved operations with the existing
gateway-qualified behavior.

## Consequences

The existing BFF is the only presentation/authentication boundary and can bound
and redact data before it reaches the browser. Preview results do not imply
reachability, deployed policy, TLS trust, MCP registration or diagnostic
verification. Future diagnostic UI work needs actual producer contracts,
namespace/role denial tests, redaction and exhaustion tests, and hosted gateway
evidence; this ADR alone supplies none of those implementation claims.
