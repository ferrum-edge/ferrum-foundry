# Table sorting and pagination

`DataTable` sorts complete collections in the browser. When `pagination` is
present, it defaults to server pagination and disables sorting for every column,
even a column with `enableSorting: true`. A page of gateway results cannot be
sorted as though it were the entire collection.

For a complete collection, pass unsliced `data` and `paginationMode="client"`.
The table applies TanStack's sorted row model before slicing by offset and limit.
The footer uses the collection length, and a sort change calls
`onPaginationChange` with offset zero. Without `pagination`, the table treats
`data` as the complete collection and sorts without slicing. Columns can opt out
with `enableSorting: false`.

Every record must have a unique, stable string `id`. Equal sort values are
ordered by ascending ID in both directions, independent of fetch order. The
table does not mutate the supplied array. Clearing sorting restores the supplied
order. `aria-sort` describes the active direction; server-page headers have no
sort indicator or click handler. The unused `onSortingChange` notification prop
was removed: sorting and slicing now belong to the table itself.

## Gateway contract and current pages

The **Pinned Gateway Contract** job in `.github/workflows/ci.yml` runs image
`ferrumedge/ferrum-edge@sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`.
It exercises live requests through `scripts/gateway-contract-smoke.mjs`; it does
not check out an OpenAPI fixture or record a corresponding gateway source SHA.
Do not infer sorting support from acceptance of an unknown query parameter.

The [canonical upstream OpenAPI specification](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
was inspected at revision
[`c27e5e55eda97047a35af0bb0fd87fea760dcb82`](https://github.com/ferrum-edge/ferrum-edge/blob/c27e5e55eda97047a35af0bb0fd87fea760dcb82/openapi.yaml).
Core resource lists declare offset/limit pagination without configurable sorting.
API specs separately declare `sort_by` and `order`; that does not establish sort
support for other endpoints or for the pinned image. No local spec copy is kept.

At the time of this change, no application page imports `DataTable`. The current
page strategies are:

| Surface | Data available | Sort behavior |
| --- | --- | --- |
| Proxies, consumers, upstreams, plugin configs | A server page normally; complete collection during search | Existing custom grid headers remain static, with no sort affordance in either mode. |
| API specs | A server page normally; complete collection during search | Existing cards have no sort affordance. |
| Other inventory and observability tables | Endpoint-specific snapshots or pages | Existing headers remain static, with no sort affordance. |
| Shared `DataTable`, server pagination | One server page | All sorting disabled. |
| Shared `DataTable`, complete collection | All records, optionally filtered | Sort the entire collection, then paginate if requested. |

When adopting `DataTable` for a `listAll()` caller, pass the complete filtered
collection, not `filterAndPage(...).items`. Keep namespace binding in the data
hook: every `listAll(scope)` request must retain the operation's `NamespaceScope`.
This change adds no gateway requests or query parameters and changes no query
keys. Any future server sorting integration must verify the deployed contract,
include ordering in query keys and every page request, and establish an ID
tie-break before enabling its headers.

## Regression coverage

`src/components/ui/DataTable.test.tsx` mounts the real component and checks
ascending/descending tbody order and indicators, clearing the sort, sorting
across page boundaries, resetting the offset, ID ties in both directions and
after reordered input, input immutability, and disabled server-page/column
affordances. Execution, lint, type checking, and build validation run only in
GitHub-hosted CI.
