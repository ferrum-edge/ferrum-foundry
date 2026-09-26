import { act, useRef, useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { button, createHarness } from "@/test/__tests__/harness";
import { Sidebar } from "./Sidebar";

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

beforeEach(() => { ui = createHarness(); });
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
});
