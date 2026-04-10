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
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  const canGoPrev = offset > 0;
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

  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-sm">
        {total === 0
          ? "No results"
          : `Showing ${rangeStart}-${rangeEnd} of ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={goToPrev}
          disabled={!canGoPrev}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
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
        <span className="text-text-secondary text-sm px-2">
          Page {currentPage} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={goToNext}
          disabled={!canGoNext}
        >
          Next
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
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
