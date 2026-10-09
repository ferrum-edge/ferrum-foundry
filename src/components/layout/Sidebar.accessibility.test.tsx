import { act, useRef, useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, createHarness } from "@/test/__tests__/harness";
import { Sidebar } from "./Sidebar";

const { auth } = vi.hoisted(() => ({
  auth: { principal: null as { namespaces?: string[] } | null },
}));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: auth.principal }) }));

let ui: ReturnType<typeof createHarness>;

function SidebarHarness() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-sidebar-dialog"
        onClick={() => setOpen(!open)}
      >Toggle sidebar</button>
      <button type="button">Background control</button>
      <Sidebar open={open} onClose={() => setOpen(false)} triggerRef={toggleRef} />
    </>
  );
}

beforeEach(() => { auth.principal = null; ui = createHarness(); });
afterEach(async () => ui.dispose());

async function mount() {
  const root = createRootRoute({ component: SidebarHarness });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
}

describe("mobile sidebar keyboard behavior", () => {
  it("contains focus while open and returns it to the toggle after Escape", async () => {
    await mount();
    const toggle = button("Toggle sidebar");
    await act(async () => {
      toggle.focus();
      toggle.click();
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog?.querySelector("button"));

    await act(async () => {
      dialog?.querySelector("a")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      button("Background control").focus();
    });
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides fleet-wide navigation from namespace-scoped principals", async () => {
    auth.principal = { namespaces: ["tenant-a"] };
    await mount();

    const links = [...document.querySelectorAll("#desktop-sidebar a")]
      .map((link) => link.textContent?.trim());
    expect(links).not.toContain("Dashboard");
    expect(links).not.toContain("Metrics");
    expect(links).not.toContain("TLS");
    expect(links).not.toContain("Cluster");
    expect(links).toContain("Health");
    expect(links).toContain("Audit Log");
    // Mesh keeps its namespace-scoped Trust tab.
    expect(links).toContain("Mesh");
  });
});
