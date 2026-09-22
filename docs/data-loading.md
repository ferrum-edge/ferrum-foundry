# Data loading and collection budgets

Ordinary navigation must not download a namespace. This document records what
the admin API actually offers, what Foundry does with it, the measured request
budgets, and what is still blocked on upstream work.

## The constraint

`GET /proxies`, `GET /upstreams`, `GET /consumers`, and `GET /plugins/config`
accept **`offset` and `limit` only**. The surveyed `openapi.yaml` declares no
`search`, `name`, `filter`, `label`, or reference (`id in (…)`) parameter on
any of them, and no bulk-resolve endpoint.

Everything below follows from that. Where a view needs an answer the gateway
will not compute — "which proxies match this text", "how many plugins run on
this proxy" — the only options are to traverse the collection or to say the
answer is unavailable. Foundry does not invent unsupported query parameters,
and it does not present a partial traversal as a complete answer.

## Rules

1. **A list page fetches one page.** Nothing about rendering twenty rows may
   require a collection scan.
2. **References are resolved for the rows on screen**, bounded by the page
   size — never by fetching the referenced collection.
3. **An expensive secondary view loads when it is requested**, not when its
   parent page opens.
4. **A conclusion that is wrong if partial is complete or it is unknown.**
   Effective-policy and membership answers traverse fully; they never report a
   partial graph. A *summary* may stop at a budget, and then it reports
   "unavailable at this size" rather than a smaller number.
5. **A traversal is cancellable.** A namespace switch, a new search term, or
   leaving the page abandons the remaining pages.
6. **Pages are walked sequentially**, each offset derived from the number of
   records the previous page actually returned. Computing offsets ahead of
   time to parallelise would assume every page except the last is exactly
   `limit` long; a gateway returning a short page would then silently drop or
   duplicate records. The existing fail-closed checks — a non-advancing page, a
   shifting total, an over-long response — stay for the same reason.

## Budgets

`SUMMARY_SCAN_BUDGET` (2,000 records, `src/api/pagination.ts`) is the point at
which a *summary* column stops traversing and reports unavailable. It is not a
cap on correctness-critical reads.

`ALL_PAGE_SIZE` (250) is the page size for traversals and for the single
catalog page a picker or a reference resolver starts from.

## Measured

`src/api/dataLoadingBudget.test.ts` is the repeatable fixture. It drives the
shipped `src/api/*` modules against a synthetic gateway that serves only
`offset`/`limit`, at the initially supported envelope (500 records per
collection) and at the 50,000-record stress target, and fails closed on the
budgets.

At **50,000 records per collection**:

| Navigation | Requests | Response bytes |
| --- | ---: | ---: |
| Proxy list, first page (rows reference upstreams in the catalog page) | 2 | 68.7 KB |
| Proxy list, deep page (every visible row references an upstream outside it) | 22 | 73.6 KB |
| Open one proxy editor | 1 | 612 B |
| Bounded plugin summary for the list column | 8 | 482 KB |
| *For comparison:* the whole upstream collection the list used to load | **200** | **11.5 MB** |

At **500 records per collection**: proxy list 2 requests, proxy editor 1
request, plugin summary 2 requests.

**What these numbers are.** Request counts and response sizes, measured
against a synthetic gateway in the Node/jsdom test environment. **What they are
not.** Browser latency. That depends on hardware, network, and rendering, and
no browser measurement is claimed here. A browser-level measurement belongs in
the critical-journey suite (#380).

## Where each rule lands

### Proxy list page

- One `GET /proxies?offset&limit` for the visible page. A search term still
  traverses — see *Still blocked* below.
- Upstream names come from `useUpstreamReferences`, which measures before it
  chooses: one `GET /upstreams?limit=250` answers any namespace whose total
  fits in that page (one request, strictly cheaper than per-row reads), and
  only a larger namespace falls back to one `GET /upstreams/{id}` per visible
  reference. A failed reference read marks that row's name unavailable and
  shows the configured id; it does not raise the global error dialog.
- The effective plugin count uses `listBoundedConfigs`. Over budget, the
  column shows `n/a` with the reason in its title. It never shows a number
  derived from a partial traversal.

### Proxy detail page

Opening an editor issues exactly **one** request: the proxy. The plugin
collection, the consumer collection, and the linked upstream are fetched when
their tab is first opened, and stay loaded afterwards so returning to a tab is
instant. The Plugins tab label reads `unknown` until its collection has
loaded — an honest unknown, not a zero.

The policy traversals themselves remain **complete**. An effective-policy
answer is an authorization conclusion; a partial plugin graph would
under-report what runs on a proxy.

### Proxy picker

`useProxyCatalog` loads one catalog page. If the namespace fits in it the
picker is complete after a single request, which is the common case. If it
does not, the picker says so — "Searching the first 250 of N proxies" — and
offers "Search all N proxies", which starts the complete traversal on demand
and stays cancellable. Selections outside the loaded page are resolved one id
at a time, so a selected member is labelled correctly instead of being shown
as missing, and a selection whose proxy is gone is labelled as such and stays
removable.

## Cancellation

`listAll`, `list`, and `listBoundedConfigs` take an `AbortSignal`, and the
Query hooks pass the one TanStack Query provides. A namespace switch abandons
the traversal that was running for the previous namespace: its remaining pages
are never requested and nothing partial is cached.

Membership plans (`src/lib/pluginMembership.ts`) deliberately pass **no**
signal. A plan's listing, preflight, apply, and rollback must complete under
the namespace they started in — a switch must not abandon a compensation
halfway.

`src/hooks/namespaceBinding.test.tsx` covers both: the abandoned traversal and
the one the displayed namespace still needs.

## Still blocked on `ferrum-edge`

- **Server-side search.** There is no `search`/`name`/`filter` parameter, so a
  nonempty search term on a list page still traverses the collection
  (cancellably, and abandoned as soon as the term changes). Restoring an
  arbitrary cap here would re-open the bugs #142 fixed, so the traversal
  stays. A bounded search needs an upstream contract.
- **Bounded effective-policy queries.** There is no endpoint that answers
  "which plugin configurations apply to proxy X". Until there is, the complete
  traversal is what keeps the authorization conclusion truthful.
- **Bulk reference resolution.** An `ids=` filter on `GET /upstreams` would
  replace up to twenty per-row reads with one request.

## Coverage

| Concern | Test |
| --- | --- |
| Budget, incompleteness, cancellation, fail-closed checks | `src/api/pagination.test.ts` |
| Request counts at 500 and 50,000 records | `src/api/dataLoadingBudget.test.ts` |
| List and detail pages issue bounded requests; over-budget counts report unavailable | `src/routes/proxies/boundedLoading.test.tsx` |
| Traversals are abandoned on a namespace switch and never retargeted | `src/hooks/namespaceBinding.test.tsx` |
| Membership completeness and picker selections survive | `src/routes/plugins/PluginDetailPage.test.tsx`, `src/routes/readTruthfulness.test.tsx` |
