import { Select } from "@/components/ui/Select";
import { useNamespace } from "@/stores/namespace";

interface HeaderProps {
  onToggleSidebar: () => void;
}

export function Header({ onToggleSidebar }: HeaderProps) {
  const { selectedNamespace, namespaces, setNamespace } = useNamespace();

  const namespaceOptions = namespaces.map((ns) => ({
    value: ns,
    label: ns,
  }));

  // Fallback options if namespaces haven't loaded yet
  const displayOptions =
    namespaceOptions.length > 0
      ? namespaceOptions
      : [{ value: selectedNamespace, label: selectedNamespace }];

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
          <span className="hidden sm:inline text-sm font-semibold text-text-secondary whitespace-nowrap">
            Active Namespace:
          </span>
          <div className="w-36 min-w-0 sm:w-44 md:w-52">
            <Select
              value={selectedNamespace}
              onValueChange={setNamespace}
              options={displayOptions}
              placeholder="Namespace"
            />
          </div>
        </div>

        {/* Connection status indicator */}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success" />
          </span>
          <span className="hidden sm:inline">Connected</span>
        </div>
      </div>
    </header>
  );
}
