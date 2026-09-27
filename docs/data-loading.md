# Data loading and collection budgets

Ordinary navigation must not download a whole namespace. This page covers what
the admin API offers, how Foundry uses it, the measured request budgets, and
what still needs upstream work.

## The constraint

`GET /proxies`, `GET /upstreams`, `GET /consumers`, and `GET /plugins/config`
accept only **`offset` and `limit`**. Ferrum Edge's `openapi.yaml` declares no
`search`, `name`, `label`, or reference (`id in (…)`) parameter on them, and no
bulk-resolve endpoint. The one filter is `proxy_id` on `GET /plugins/config`
(Ferrum Edge v0.9.7, ferrum-edge#5726): an exact match, paginated over the
matches, with `pagination.total` counting only the matches.

So when a view needs an answer the gateway will not compute ("which proxies
match this text", "how many plugins run on this proxy"), Foundry either
traverses the collection or says the answer is unavailable. It never invents
query parameters, and it never presents a partial traversal as a complete
answer.

## Rules

1. **A list page fetches one page.** Rendering twenty rows never requires a
   collection scan.
2. **References are resolved for the rows on screen**, bounded by the page
   size, never by fetching the referenced collection.
3. **An expensive secondary view loads when it is opened**, not when its
   parent page opens.
4. **A conclusion that is wrong if partial is complete or unknown.**
   Effective-policy and membership answers traverse fully and never report a
   partial graph. A *summary* may stop at a budget, and then reports
   "unavailable at this size" rather than a smaller number.
5. **A traversal can be cancelled.** A namespace switch, a new search term, or
   leaving the page abandons the remaining pages.
6. **Pages are walked one after another**, each offset taken from how many
   records the previous page actually returned. Computing offsets in advance
   to fetch in parallel assumes every page but the last is exactly `limit`
   long; a short page would then silently drop or duplicate records. The
   fail-closed checks (a page that does not advance, a total that shifts, an
   over-long response) stay for the same reason.

## Budgets

`SUMMARY_SCAN_BUDGET` (2,000 records, `src/api/pagination.ts`) is where a
*summary* column stops traversing and reports unavailable. It is not a cap on
reads that must be complete.

`ALL_PAGE_SIZE` (250) is the page size for traversals and for the single
catalog page a picker or reference resolver starts from.

## Measured

`src/api/dataLoadingBudget.test.ts` drives the real `src/api/*` modules
against a synthetic gateway that supports only `offset`/`limit`, at 500 records
per collection (the supported envelope) and at 50,000 (the stress target), and
fails if a budget is exceeded.

At **50,000 records per collection**:

| Navigation | Requests | Response bytes |
| --- | ---: | ---: |
| Proxy list, first page (rows reference upstreams in the catalog page) | 2 | 68.7 KB |
| Proxy list, deep page (every visible row references an upstream outside it) | 22 | 73.6 KB |
| Open one proxy editor | 1 | 612 B |
| Bounded plugin summary for the list column | 8 | 482 KB |
| *For comparison:* loading the whole upstream collection | **200** | **11.5 MB** |

At **500 records per collection**: proxy list 2 requests, proxy editor 1,
plugin summary 2.

These are request counts and response sizes from the Node/jsdom test
environment. They are not browser latency, which depends on hardware, network,
and rendering; no latency figure is claimed.

## Where each rule applies

### Proxy list page

- One `GET /proxies?offset&limit` for the visible page. A search term still
  traverses; see [Still blocked](#still-blocked-on-ferrum-edge).
- Upstream names come from `useUpstreamReferences`. If the namespace's
  upstreams fit in one `GET /upstreams?limit=250`, that single request answers
  every row. Otherwise it reads one `GET /upstreams/{id}` per visible
  reference. A failed reference read shows the configured id with the name
  marked unavailable, and does not open the global error dialog.
- The effective plugin count uses `listBoundedConfigs`. Over budget, the
  column shows `n/a` with the reason in its tooltip, never a number from a
  partial traversal.

### Proxy detail page

Opening the editor makes exactly **one** request: the proxy. The plugin
collection, the consumer collection, and the linked upstream are fetched when
their tab is first opened and stay loaded afterwards. The Plugins tab label
reads `unknown` until its data has loaded, rather than showing zero.

The policy traversals stay **complete**. An effective-policy answer is an
authorization conclusion, and a partial plugin graph would under-report what
runs on a proxy.

The complete graph is merged the way the gateway merges scopes (Ferrum Edge
v0.9.7 `src/plugin_cache.rs`, `remove_shadowed_global_plugin`):

- An enabled proxy-scoped configuration listed in the proxy's `plugins`, or an
  attached proxy-group configuration with no `proxy_id`, replaces every global
  configuration with the same plugin name, before the protocol filter runs.
- Edge admits a group configuration only when it has scope `proxy_group` and no
  `proxy_id` (`validate_plugin_security_composition_candidate`). Foundry treats
  an omitted or `null` `proxy_id` as absent and excludes any other value,
  including an empty string. Such an excluded group configuration neither runs
  nor hides a global one.
- The request and response size limiters, and the no-static-rules transformer
  that the Istio VirtualService translator emits for a proxy, are additive and
  leave the global instance in place.
- A disabled or unattached scoped configuration shadows nothing.

Plugin counts, the proxy's consumer analysis, and a consumer's Matched Proxies
all use this one merge.

The Plugins tab also lists proxy-scoped configurations that name this proxy
but do not run on it (disabled, or not in the proxy's `plugins`). That list
comes from `GET /plugins/config?proxy_id=<id>` (`plugins.listConfigsForProxy`),
usually one request whatever the namespace size. It cannot replace the
traversal above, because global and proxy-group configurations also run on the
proxy and have no `proxy_id`. If the response includes a configuration for
another proxy, the gateway ignored the filter, and the read fails rather than
showing or traversing the namespace.

### Consumer and plugin detail pages

A consumer editor makes one request for the consumer. The proxy and plugin
collections behind "Matched Proxies" load when that tab is first opened; its
label reads `unknown` until then. A consumer's access depends on no other
consumer, so the consumer collection is never traversed for it. Each proxy is
analyzed for this consumer alone, using an attachment index built once per
plugin collection (`src/lib/effectivePolicy.ts`), so the tab stays linear in
the number of proxies.

A plugin editor traverses the proxy collection only for a `proxy_group` plugin,
whose membership needs it.

### Proxy picker

`useProxyCatalog` loads one catalog page. If the namespace fits, the picker is
complete after one request, which is the common case. If not, it says so
("Searching the first 250 of N proxies") and offers "Search all N proxies",
which starts a full, cancellable traversal. Selected proxies outside the loaded
page are resolved one id at a time, so they are labelled correctly, and a
selection whose proxy no longer exists is labelled as such and can still be
removed.

### TLS managed stores and ACME

Managed TLS records and the ACME certificates, orders, and accounts panels each
request one server page and use the gateway's total for their page controls.
They never traverse the rest of a fleet-global collection. The ACME orders page
polls every 15 seconds only while an order on that page can still change.

## Cancellation

`listAll`, `list`, and `listBoundedConfigs` take an `AbortSignal`, and the
Query hooks pass the one TanStack Query provides. A namespace switch abandons
the traversal running for the previous namespace: its remaining pages are never
requested and nothing partial is cached.

Membership plans (`src/lib/pluginMembership.ts`) deliberately pass **no**
signal. A plan's listing, preflight, apply, and rollback must finish in the
namespace they started in, so a switch cannot abandon a rollback halfway.

## Still blocked on `ferrum-edge`

- **Server-side search.** There is no search or filter parameter, so a search
  term on a list page traverses the collection (cancellably, and abandoned when
  the term changes). Capping that traversal would return wrong results, so a
  bounded search needs an upstream API.
- **Bounded effective-policy queries.** `?proxy_id=` answers "which
  proxy-scoped configurations target proxy X", not "which configurations apply
  to it". Global and proxy-group configurations would need a scope filter the
  admin API does not have. Until then, the complete traversal keeps the
  authorization answer truthful.
- **Bulk reference resolution.** An `ids=` filter on `GET /upstreams` would
  replace up to twenty per-row reads with one request.

## Coverage

| Concern | Test |
| --- | --- |
| Budget, incompleteness, cancellation, fail-closed checks | `src/api/pagination.test.ts` |
| Request counts at 500 and 50,000 records | `src/api/dataLoadingBudget.test.ts` |
| List and detail pages issue bounded requests; over-budget counts report unavailable | `src/routes/proxies/boundedLoading.test.tsx` |
| One proxy's configurations come from the filtered set; an unfiltered answer is refused | `src/api/plugins.proxyFilter.test.ts`, `src/routes/proxies/boundedLoading.test.tsx` |
| TLS and ACME collections request one server page and advance by server offset | `src/routes/tls/TlsWorkflows.test.tsx`, `src/hooks/useTls.test.tsx` |
| Traversals are abandoned on a namespace switch and never retargeted | `src/hooks/namespaceBinding.test.tsx` |
| Membership completeness and picker selections survive | `src/routes/plugins/PluginDetailPage.test.tsx`, `src/routes/readTruthfulness.test.tsx` |
