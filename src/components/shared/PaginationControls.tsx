import { Button } from "../ui/Button";

export interface PaginationParams {
  offset: number;
  limit: number;
}

export interface PaginationControlsProps {
  offset: number;
  limit: number;
  total: number;
  onChange: (params: PaginationParams) => void;
}

export function PaginationControls({
  offset,
  limit,
  total,
  onChange,
}: PaginationControlsProps) {
  const currentPage = total === 0 ? 1 : Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  const canGoPrev = total > 0 && offset > 0;
  const canGoNext = offset + limit < total;

  const goToPrev = () => {
    if (canGoPrev) {
      onChange({ offset: Math.max(0, offset - limit), limit });
    }
  };

  const goToNext = () => {
    if (canGoNext) {
      onChange({ offset: offset + limit, limit });
    }
  };

  if (total > 0 && offset >= total) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-text-muted text-sm">
          Page out of range — {total} results available
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ offset: (totalPages - 1) * limit, limit })}
        >
          Go to last page
        </Button>
      </div>
    );
  }

  // Both labels stay on one line at phone width: the range drops its
  // "Showing" prefix and the page indicator shortens to "n / m" below sm.
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-text-muted text-xs sm:text-sm whitespace-nowrap tabular-nums">
        {total === 0 ? (
          "No results"
        ) : (
          <>
            <span className="hidden sm:inline">Showing </span>
            {rangeStart}–{rangeEnd} of {total}
          </>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={goToPrev}
          disabled={!canGoPrev}
          aria-label="Previous page"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M15 18L9 12L15 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Prev
        </Button>
        <span className="text-text-secondary text-xs sm:text-sm whitespace-nowrap tabular-nums px-1">
          <span className="sm:hidden">
            {currentPage} / {totalPages}
          </span>
          <span className="hidden sm:inline">
            Page {currentPage} of {totalPages}
          </span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={goToNext}
          disabled={!canGoNext}
          aria-label="Next page"
        >
          Next
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M9 18L15 12L9 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      </div>
    </div>
  );
}
