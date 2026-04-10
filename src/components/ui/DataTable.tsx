import { useState, useRef, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Skeleton } from "./Skeleton";
import { SearchBar } from "../shared/SearchBar";
import { PaginationControls } from "../shared/PaginationControls";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataTablePagination {
  offset: number;
  limit: number;
  total: number;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  pagination?: DataTablePagination;
  onPaginationChange?: (params: { offset: number; limit: number }) => void;
  isLoading: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  virtualScroll?: boolean;
  tableHeight?: string;
  onSortingChange?: (sorting: SortingState) => void;
}

// ---------------------------------------------------------------------------
// Page size options
// ---------------------------------------------------------------------------

const PAGE_SIZES = [25, 50, 100, 250] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataTable<T>({
  columns,
  data,
  pagination,
  onPaginationChange,
  isLoading,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  onRowClick,
  emptyMessage = "No data found.",
  virtualScroll = false,
  tableHeight = "calc(100vh - 300px)",
  onSortingChange,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      onSortingChange?.(next);
    },
    [sorting, onSortingChange],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
  });

  const { rows } = table.getRowModel();

  // Virtual scrolling
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 44,
    overscan: 10,
    enabled: virtualScroll,
  });

  const currentLimit = pagination?.limit ?? 25;

  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLimit = Number(e.target.value);
    onPaginationChange?.({ offset: 0, limit: newLimit });
  };

  // ----- Rendering helpers -----

  const renderSkeletonRows = () => (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-b border-border/50">
          {table.getAllColumns().map((col) => (
            <td key={col.id} className="px-4 py-3">
              <Skeleton className="h-4 w-full" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );

  const renderEmptyState = () => (
    <tr>
      <td
        colSpan={columns.length}
        className="px-4 py-16 text-center text-text-muted text-sm"
      >
        {emptyMessage}
      </td>
    </tr>
  );

  const renderRow = (row: (typeof rows)[number]) => (
    <tr
      key={row.id}
      className={`border-b border-border/50 transition-colors duration-100 ${onRowClick ? "cursor-pointer hover:bg-bg-card-hover" : "hover:bg-bg-card-hover/50"}`}
      onClick={() => onRowClick?.(row.original)}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-4 py-3 text-sm text-text-primary">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );

  const renderVirtualRows = () => {
    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    return (
      <>
        {virtualItems.length > 0 && (
          <tr>
            <td
              colSpan={columns.length}
              style={{ height: virtualItems[0].start, padding: 0 }}
            />
          </tr>
        )}
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <tr
              key={row.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={`border-b border-border/50 transition-colors duration-100 ${onRowClick ? "cursor-pointer hover:bg-bg-card-hover" : "hover:bg-bg-card-hover/50"}`}
              onClick={() => onRowClick?.(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className="px-4 py-3 text-sm text-text-primary"
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          );
        })}
        {virtualItems.length > 0 && (
          <tr>
            <td
              colSpan={columns.length}
              style={{
                height:
                  totalSize -
                  virtualItems[virtualItems.length - 1].end,
                padding: 0,
              }}
            />
          </tr>
        )}
      </>
    );
  };

  // ----- Main render -----

  return (
    <div className="bg-bg-card border border-border rounded-xl overflow-hidden flex flex-col">
      {/* Header bar */}
      {(onSearchChange || onPaginationChange) && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border">
          {onSearchChange ? (
            <SearchBar
              value={searchValue ?? ""}
              onChange={onSearchChange}
              placeholder={searchPlaceholder}
              className="w-72"
            />
          ) : (
            <div />
          )}
          {onPaginationChange && (
            <div className="flex items-center gap-2 shrink-0">
              <label className="text-text-muted text-xs">Rows</label>
              <select
                value={currentLimit}
                onChange={handlePageSizeChange}
                className="bg-bg-input border border-border rounded-lg px-2 py-1.5 text-text-primary text-xs cursor-pointer focus:border-orange focus:ring-1 focus:ring-orange/30 outline-none"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div
        ref={tableContainerRef}
        className="overflow-auto"
        style={virtualScroll ? { height: tableHeight } : undefined}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="bg-bg-primary/50">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();

                  return (
                    <th
                      key={header.id}
                      className={`px-4 py-3 text-left text-text-secondary text-xs font-semibold uppercase tracking-wider select-none whitespace-nowrap ${canSort ? "cursor-pointer hover:text-text-primary" : ""}`}
                      style={{
                        width:
                          header.getSize() !== 150
                            ? header.getSize()
                            : undefined,
                      }}
                      onClick={
                        canSort
                          ? header.column.getToggleSortingHandler()
                          : undefined
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                        {canSort && (
                          <span className="text-text-muted">
                            {sortDir === "asc" ? (
                              <SortAscIcon />
                            ) : sortDir === "desc" ? (
                              <SortDescIcon />
                            ) : (
                              <SortNeutralIcon />
                            )}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading
              ? renderSkeletonRows()
              : rows.length === 0
                ? renderEmptyState()
                : virtualScroll
                  ? renderVirtualRows()
                  : rows.map(renderRow)}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {pagination && onPaginationChange && (
        <div className="bg-bg-card border-t border-border px-4 py-3">
          <PaginationControls
            offset={pagination.offset}
            limit={pagination.limit}
            total={pagination.total}
            onChange={onPaginationChange}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sorting icons
// ---------------------------------------------------------------------------

function SortAscIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 5V19M12 5L6 11M12 5L18 11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortDescIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 19V5M12 19L6 13M12 19L18 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortNeutralIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="opacity-40"
    >
      <path
        d="M8 9L12 5L16 9M8 15L12 19L16 15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
