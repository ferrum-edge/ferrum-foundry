import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Rendered by the router for any path that matches no route. It replaces
 * TanStack Router's unstyled default so a mistyped or stale deep link lands
 * on a page that looks like the rest of the app and offers a way back.
 */
export function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-[50vh] p-8">
      <Card className="max-w-lg w-full">
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-bg-card-hover flex items-center justify-center">
            <svg
              className="w-6 h-6 text-text-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary">Page not found</h2>
          <p className="text-sm text-text-secondary">
            The address <code className="font-mono text-text-primary">{window.location.pathname}</code> does
            not match any Foundry page. The resource may have been renamed or deleted, or the link may be
            out of date.
          </p>
          <Link to="/">
            <Button>Go to Dashboard</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
