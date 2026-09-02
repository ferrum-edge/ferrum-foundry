import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export interface ErrorFallbackProps {
  /** The caught error, if any. Only its message is shown to the user. */
  error?: Error | null;
  /** Optional recovery action, for example the router's `reset`. */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * Shared presentational error panel used by the layout's class-based
 * ErrorBoundary and by the router's `defaultErrorComponent`, so a render
 * failure inside a route looks the same as one inside the shell.
 */
export function ErrorFallback({ error, onRetry, retryLabel = "Reload" }: ErrorFallbackProps) {
  return (
    <div className="flex items-center justify-center min-h-[50vh] p-8">
      <Card className="max-w-lg w-full border-danger/30">
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center">
            <svg
              className="w-6 h-6 text-danger"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Something went wrong</h2>
          <p className="text-sm text-text-secondary" role="alert">
            {error?.message || "An unexpected error occurred."}
          </p>
          <Button variant="danger" onClick={onRetry ?? (() => window.location.reload())}>
            {retryLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}
