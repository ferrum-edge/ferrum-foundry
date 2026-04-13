/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy search picker (single + multi select)       */
/* ------------------------------------------------------------------ */

import { useState, useMemo, useRef, useEffect } from "react";
import { useProxies } from "@/hooks/useProxies";
import type { Proxy } from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface ProxySearchPickerBaseProps {
  label?: string;
  error?: string;
  helpText?: string;
}

interface SingleProps extends ProxySearchPickerBaseProps {
  mode: "single";
  value: string;
  onChange: (proxyId: string) => void;
}

interface MultiProps extends ProxySearchPickerBaseProps {
  mode: "multi";
  value: string[];
  onChange: (proxyIds: string[]) => void;
}

export type ProxySearchPickerProps = SingleProps | MultiProps;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function proxyLabel(p: Proxy): string {
  return p.name ? `${p.name} (${p.listen_path})` : p.listen_path;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ProxySearchPicker(props: ProxySearchPickerProps) {
  const { label, error, helpText, mode, value, onChange } = props;
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch all proxies (high limit to get them all for the picker)
  const { data, isLoading } = useProxies({ limit: 1000 });
  const proxies = data?.data ?? [];

  // Filter by search term
  const filtered = useMemo(() => {
    if (!search.trim()) return proxies;
    const q = search.toLowerCase();
    return proxies.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        p.listen_path.toLowerCase().includes(q) ||
        p.backend_host.toLowerCase().includes(q),
    );
  }, [proxies, search]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Selected proxy objects for display
  const selectedProxies = useMemo(() => {
    if (mode === "single") {
      const found = proxies.find((p) => p.id === value);
      return found ? [found] : [];
    }
    return proxies.filter((p) => (value as string[]).includes(p.id));
  }, [proxies, value, mode]);

  /* ---------- Handlers ---------- */

  const handleSelect = (proxy: Proxy) => {
    if (mode === "single") {
      (onChange as SingleProps["onChange"])(proxy.id);
      setOpen(false);
      setSearch("");
    } else {
      const current = value as string[];
      if (current.includes(proxy.id)) {
        (onChange as MultiProps["onChange"])(current.filter((id) => id !== proxy.id));
      } else {
        (onChange as MultiProps["onChange"])([...current, proxy.id]);
      }
    }
  };

  const handleRemove = (proxyId: string) => {
    if (mode === "single") {
      (onChange as SingleProps["onChange"])("");
    } else {
      (onChange as MultiProps["onChange"])((value as string[]).filter((id) => id !== proxyId));
    }
  };

  const isSelected = (proxyId: string): boolean => {
    if (mode === "single") return value === proxyId;
    return (value as string[]).includes(proxyId);
  };

  /* ---------- Render ---------- */

  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-1.5">
      {label && (
        <span className="text-text-secondary text-sm font-medium">{label}</span>
      )}

      {/* Selected pills (multi) or selected display (single) */}
      {selectedProxies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedProxies.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1.5 bg-orange/10 text-orange-light border border-orange/20 rounded-md px-2.5 py-1 text-xs font-medium"
            >
              <span className="truncate max-w-[200px]">{proxyLabel(p)}</span>
              <button
                type="button"
                onClick={() => handleRemove(p.id)}
                className="shrink-0 hover:text-danger transition-colors"
                aria-label={`Remove ${proxyLabel(p)}`}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={
            mode === "single"
              ? selectedProxies.length > 0
                ? "Change proxy..."
                : "Search proxies by name, path, or ID..."
              : "Search proxies to add..."
          }
          className={`w-full min-w-0 bg-bg-input border rounded-lg px-3 py-2 text-text-primary text-sm placeholder:text-text-muted transition-colors duration-150 ${
            error
              ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30"
              : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"
          }`}
        />

        {/* Dropdown */}
        {open && (
          <div className="absolute z-50 mt-1 w-full bg-bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            <div className="max-h-[16rem] overflow-y-auto p-1">
              {isLoading && (
                <div className="px-3 py-4 text-sm text-text-muted text-center">
                  Loading proxies...
                </div>
              )}

              {!isLoading && filtered.length === 0 && (
                <div className="px-3 py-4 text-sm text-text-muted text-center">
                  {search ? "No proxies match your search" : "No proxies available"}
                </div>
              )}

              {!isLoading &&
                filtered.map((proxy) => {
                  const selected = isSelected(proxy.id);
                  return (
                    <button
                      key={proxy.id}
                      type="button"
                      onClick={() => handleSelect(proxy)}
                      className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                        selected
                          ? "bg-orange/10 text-orange-light"
                          : "text-text-primary hover:bg-bg-card-hover"
                      }`}
                    >
                      {/* Checkbox indicator for multi mode */}
                      {mode === "multi" && (
                        <span
                          className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                            selected
                              ? "bg-orange border-orange text-white"
                              : "border-border bg-bg-input"
                          }`}
                        >
                          {selected && (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">
                          {proxy.name || proxy.listen_path}
                        </div>
                        <div className="text-xs text-text-muted truncate">
                          {proxy.name ? `${proxy.listen_path} · ` : ""}
                          {proxy.backend_protocol}://{proxy.backend_host}:{proxy.backend_port}
                          <span className="ml-1.5 font-mono opacity-70">{proxy.id.slice(0, 12)}...</span>
                        </div>
                      </div>
                      {/* Single mode check mark */}
                      {mode === "single" && selected && (
                        <svg className="shrink-0 w-4 h-4 text-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}
      {!error && helpText && <p className="text-text-muted text-xs">{helpText}</p>}
    </div>
  );
}
