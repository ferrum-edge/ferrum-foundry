/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – page title bar                                    */
/*                                                                     */
/*  Every page opens with the same block: an optional trail back to    */
/*  its parent list, the page's one `h1`, a short description, and the */
/*  page-level actions. Below `sm` the actions wrap under the text     */
/*  instead of squeezing the description into a narrow column.         */
/* ------------------------------------------------------------------ */

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export interface PageCrumb {
  label: string;
  /** A route path; the last crumb is the current page and takes none. */
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level actions, e.g. a create or delete button. */
  actions?: ReactNode;
  /**
   * Trail from the parent list to this page, e.g.
   * `[{ label: "Proxies", to: "/proxies" }, { label: "Orders API" }]`.
   */
  breadcrumbs?: PageCrumb[];
  /** Secondary identity shown in monospace under the title (a resource ID). */
  meta?: ReactNode;
}

export function PageHeader({ title, description, actions, breadcrumbs, meta }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs crumbs={breadcrumbs} />}
        <h1 className="text-2xl font-bold text-text-primary break-words">{title}</h1>
        {meta && (
          <p className="text-text-muted text-sm mt-1 font-mono break-all">{meta}</p>
        )}
        {description && (
          <p className="text-text-muted text-sm mt-1 max-w-3xl">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-3 sm:shrink-0 sm:justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: PageCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1.5">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${index}:${crumb.label}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="text-text-muted">
                  /
                </span>
              )}
              {crumb.to && !current ? (
                <Link
                  to={crumb.to}
                  // A parent crumb is never the current page. Without `exact`
                  // TanStack marks `/proxies` active (aria-current="page") on
                  // `/proxies/:id`.
                  activeOptions={{ exact: true }}
                  className="text-text-secondary hover:text-orange transition-colors"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={current ? "page" : undefined}
                  className="min-w-0 truncate text-text-muted"
                  title={crumb.label}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
