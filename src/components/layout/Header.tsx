import { useId } from "react";
import { Select } from "@/components/ui/Select";
import { useNamespace } from "@/stores/namespace";
import { useNamespaces } from "@/hooks/useNamespaces";
import { useTheme } from "@/stores/theme";
import { useAuth } from "@/stores/auth";
import { useBffReadiness } from "@/hooks/useBffHealth";

interface HeaderProps {
  onToggleSidebar: () => void;
}

export function Header({ onToggleSidebar }: HeaderProps) {
  const namespaceLabelId = useId();
  const { selectedNamespace, setNamespace } = useNamespace();
  const { data: namespaces } = useNamespaces();
  const { theme, toggleTheme } = useTheme();
  const { logout, principal } = useAuth();
  const readiness = useBffReadiness();

  // A failed background check retains the last successful data in React Query.
  const unreachable =
    readiness.isError || (readiness.isFetching && readiness.failureCount > 0);
  const connection = unreachable
    ? "unavailable"
    : (readiness.data?.status ?? "unknown");
  const connectionLabel = unreachable
    ? "Unreachable"
    : connection === "ready"
      ? "Connected"
      : connection === "degraded"
        ? "Degraded"
        : connection === "unavailable"
          ? "Disconnected"
          : "Checking";
  const connectionColor = connection === "ready"
    ? "bg-success"
    : connection === "degraded"
      ? "bg-warning"
      : connection === "unavailable"
        ? "bg-danger"
        : "bg-text-muted";

  // Always offer the full namespace set from GET /namespaces; include the
  // selected namespace even if the list hasn't loaded (or omits it) so the
  // control never collapses to fewer options after a switch.
  const namespaceList = namespaces ?? [];
  const displayOptions = (
    namespaceList.includes(selectedNamespace)
      ? namespaceList
      : [selectedNamespace, ...namespaceList]
  ).map((ns) => ({ value: ns, label: ns }));

  return (
    <header className="fixed top-0 right-0 left-0 md:left-[var(--sidebar-width)] h-[var(--nav-height)] bg-bg-card border-b border-border z-20 flex items-center justify-between px-4">
      {/* Left side */}
      <div className="flex items-center gap-3">
        {/* Hamburger - mobile only */}
        <button
          onClick={onToggleSidebar}
          className="md:hidden p-1.5 rounded-lg text-text-secondary hover:bg-bg-card-hover hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Toggle sidebar"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
            />
          </svg>
        </button>
      </div>

      {/* Right side */}
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {/* Namespace selector */}
        <div className="flex min-w-0 items-center gap-2">
          <span
            id={namespaceLabelId}
            className="hidden sm:inline text-sm font-semibold text-text-secondary whitespace-nowrap"
          >
            Active Namespace:
          </span>
          <div className="w-36 min-w-0 sm:w-44 md:w-52">
            <Select
              aria-labelledby={namespaceLabelId}
              value={selectedNamespace}
              onValueChange={setNamespace}
              options={displayOptions}
              placeholder="Namespace"
            />
          </div>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-lg text-text-secondary hover:bg-bg-card-hover hover:text-text-primary transition-colors cursor-pointer"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          )}
        </button>

        {/* Connection status indicator */}
        <div
          className="flex items-center gap-2 text-xs text-text-muted"
          title={principal ? `${principal.displayName} · ${principal.role}` : connectionLabel}
        >
          <span className="relative flex h-2.5 w-2.5">
            {connection === "ready" && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-50" />
            )}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${connectionColor}`} />
          </span>
          <span className="hidden sm:inline">{connectionLabel}</span>
        </div>

        {/* Sign out */}
        <button
          onClick={() => void logout()}
          className="p-1.5 rounded-lg text-text-secondary hover:bg-bg-card-hover hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Sign out"
          title="Sign out"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
