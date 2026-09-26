import { useRef, useState } from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ErrorBoundary } from "./ErrorBoundary";
import { GatewayMetadataBanner } from "@/components/shared/GatewayMetadataBanner";

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="min-h-screen bg-bg-primary">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        triggerRef={sidebarToggleRef}
      />
      <Header
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        sidebarOpen={sidebarOpen}
        sidebarToggleRef={sidebarToggleRef}
      />

      <main className="md:ml-[var(--sidebar-width)] mt-[var(--nav-height)] p-6">
        <GatewayMetadataBanner />
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
