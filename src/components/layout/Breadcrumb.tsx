import { Link, useMatches } from "@tanstack/react-router";

export function Breadcrumb() {
  const matches = useMatches();

  // Filter out root route and build breadcrumb items from route context/path
  const crumbs = matches
    .filter((match) => match.pathname !== "/" || matches.length === 1)
    .map((match) => {
      // Derive a label from the pathname segment
      const segments = match.pathname.split("/").filter(Boolean);
      const label =
        segments.length === 0
          ? "Dashboard"
          : segments[segments.length - 1].charAt(0).toUpperCase() +
            segments[segments.length - 1].slice(1);

      return {
        label,
        to: match.pathname,
      };
    });

  if (crumbs.length <= 1) return null;

  return (
    <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={crumb.to} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-text-muted">/</span>}
            {isLast ? (
              <span className="text-text-primary font-medium">
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.to}
                className="text-text-secondary hover:text-orange transition-colors"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
