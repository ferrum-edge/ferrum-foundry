# Table sorting and pagination

## `DataTable` sorting

`DataTable` (`src/components/ui/DataTable.tsx`) sorts only complete
collections, in the browser. A single page of gateway results cannot be sorted
as if it were the whole collection.

| Props | Sorting |
| --- | --- |
| `pagination` with the default `paginationMode="server"` | Disabled for every column, even one with `enableSorting: true`. Headers have no sort indicator or click handler. |
| `pagination` with `paginationMode="client"` and unsliced `data` | Sorts the whole collection, then slices by offset and limit. The footer counts the full collection, and a sort change calls `onPaginationChange` with offset zero. |
| No `pagination` | Treats `data` as the complete collection and sorts it without slicing. |

Columns can opt out with `enableSorting: false`.

Every record needs a unique, stable string `id`. Rows with equal sort values
are ordered by ascending ID in both directions, regardless of fetch order. The
table does not mutate the supplied array, and clearing the sort restores the
supplied order. `aria-sort` reflects the active direction.

## Current pages

No application page uses `DataTable` today. Current strategies:

| Surface | Data available | Sort behavior |
| --- | --- | --- |
| Proxies, consumers, upstreams, plugin configs | A server page normally; the complete collection during search | Static headers, no sort control. |
| API specs | A server page normally; the complete collection during search | Cards, no sort control. |
| Other inventory and observability tables | Endpoint-specific snapshots or pages | Static headers, no sort control. |

When adopting `DataTable` for a `listAll()` caller, pass the complete filtered
collection, not `filterAndPage(...).items`. Keep namespace binding in the data
hook: every `listAll(scope)` request must keep the operation's
`NamespaceScope`.

## Gateway sorting support

The [upstream OpenAPI specification](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
(inspected at
[`c27e5e55`](https://github.com/ferrum-edge/ferrum-edge/blob/c27e5e55eda97047a35af0bb0fd87fea760dcb82/openapi.yaml))
gives core resource lists offset/limit pagination with no sorting. Only API
specs declare `sort_by` and `order`, which does not imply sorting on other
endpoints. Foundry sends no sort parameters, and a gateway accepting an unknown
query parameter is not evidence that it sorts.

Server-side sorting would need to verify the deployed contract, include the
ordering in query keys and every page request, and use an ID tie-break before
enabling sortable headers.

## Narrow resource grids

Custom resource grids wrap their header and rows in `ResourceGrid`
(`src/components/ui/ResourceGrid.tsx`), an inner horizontal scroller. Header
and rows share one canvas at least 52rem wide, so fixed columns cannot squeeze
out the resource identity column. Cluster backend capabilities use 48rem; the
authorization grids in proxy and consumer details use 40rem. On wide cards the
existing column templates still fill the space. Scrolling depends on the card
width, not a viewport breakpoint, so it also applies with the desktop sidebar
open.

The scroller is a named, keyboard-focusable region. Pass empty and error
messages through `emptyState` so they, and any create buttons, stay within the
card width outside the wide canvas. Keep column headers inside the scroller
even when the collection is empty.

## Test coverage

- `src/components/ui/DataTable.test.tsx` mounts the real component and checks
  row order and indicators in both directions, clearing the sort, sorting
  across page boundaries, the offset reset, ID tie-breaks (including after
  reordered input), input immutability, and disabled server-page and column
  sorting.
- `src/routes/resourceGrids.test.tsx` mounts all nine `ResourceGrid` surfaces
  and checks the scroller, minimum width, shared header/row template, identity
  cell, and placement of empty/error feedback. Vitest runs these in jsdom,
  which cannot measure layout or prove text is visible.

No CI job checks narrow-viewport layout. The Critical Journeys job drives
Chromium through Playwright, but its journeys do not test layout. Check by hand
in a browser at 390×844: populated and empty lists, the mesh service graph, TLS
inventory, cluster capabilities, and the authorization tabs in proxy and
consumer details. Confirm identity text has room, horizontal scrolling reaches
every column without page overflow, headers stay aligned with rows, and
empty-state actions stay visible. Also check a desktop viewport in both themes.
