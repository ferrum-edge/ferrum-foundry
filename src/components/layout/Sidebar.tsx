import { Link, useRouterState } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { NavIcon, type NavIconName } from "@/components/ui/icons";
import { BrandMark } from "./BrandMark";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

interface NavItem {
  label: string;
  to: string;
  icon: NavIconName;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    items: [{ label: "Dashboard", to: "/", icon: "dashboard" }],
  },
  {
    title: "Configure",
    items: [
      { label: "Proxies", to: "/proxies", icon: "proxies" },
      { label: "Upstreams", to: "/upstreams", icon: "upstreams" },
      { label: "Consumers", to: "/consumers", icon: "consumers" },
      { label: "Plugins", to: "/plugins", icon: "plugins" },
      { label: "API Specs", to: "/api-specs", icon: "apiSpecs" },
    ],
  },
  {
    title: "Security",
    items: [
      { label: "TLS", to: "/tls", icon: "tls" },
      { label: "Audit Log", to: "/audit", icon: "audit" },
    ],
  },
  {
    title: "Operate",
    items: [
      { label: "Metrics", to: "/metrics", icon: "metrics" },
      { label: "Health", to: "/status", icon: "health" },
      { label: "Cluster", to: "/cluster", icon: "cluster" },
      { label: "Mesh", to: "/mesh", icon: "mesh" },
      { label: "Settings", to: "/settings", icon: "settings" },
    ],
  },
];

export function Sidebar({ open, onClose, triggerRef }: SidebarProps) {
  const [mobileViewport, setMobileViewport] = useState(true);
  const closingForDesktop = useRef(false);
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => {
      const isMobile = media.matches;
      setMobileViewport(isMobile);
      if (!isMobile && open) {
        closingForDesktop.current = true;
        onClose();
      }
    };
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, [onClose, open]);

  function isActive(to: string) {
    if (to === "/") return currentPath === "/";
    return currentPath === to || currentPath.startsWith(to + "/");
  }

  const sidebarContent = (
    <aside className="flex flex-col h-full w-[var(--sidebar-width)] bg-bg-card border-r border-border">
      {/* Logo */}
      <div className="flex items-center px-5 h-[var(--nav-height)] border-b border-border shrink-0">
        <BrandMark />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-3">
        {navSections.map((section, sectionIndex) => (
          <div key={section.title ?? sectionIndex} className={sectionIndex > 0 ? "mt-4" : ""}>
            {section.title && (
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                {section.title}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = isActive(item.to);
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={onClose}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 ${
                        active
                          ? "bg-orange/10 text-orange border-l-2 border-orange"
                          : "text-text-secondary hover:bg-bg-card-hover hover:text-text-primary"
                      }`}
                    >
                      <span className="shrink-0"><NavIcon name={item.icon} /></span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div
        id="desktop-sidebar"
        className="hidden md:block fixed top-0 left-0 h-screen z-30"
      >
        {sidebarContent}
      </div>

      {/* Mobile overlay */}
      <DialogPrimitive.Root
        open={open && mobileViewport}
        onOpenChange={(nextOpen) => !nextOpen && onClose()}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <DialogPrimitive.Content
            id="mobile-sidebar-dialog"
            aria-label="Main navigation"
            aria-modal="true"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (closingForDesktop.current) {
                closingForDesktop.current = false;
                document.querySelector<HTMLElement>("#desktop-sidebar a")?.focus();
              } else {
                triggerRef?.current?.focus();
              }
            }}
            className="md:hidden fixed inset-y-0 left-0 z-40 h-full outline-none"
          >
            <DialogPrimitive.Title className="sr-only">
              Main navigation
            </DialogPrimitive.Title>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sidebar"
              className="absolute right-3 top-3 z-10 rounded-md p-2 text-text-secondary hover:bg-bg-card-hover"
            >
              <span aria-hidden="true">×</span>
            </button>
            <div className="relative h-full">{sidebarContent}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
