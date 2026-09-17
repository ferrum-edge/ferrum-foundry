import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RefreshControl } from "./RefreshControl";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function render(ui: ReactElement) {
  await act(async () => root.render(ui));
}

// jsdom has no layout engine. These assertions protect the responsive
// container contract; they do not claim pixel visibility at 390px.
describe("RefreshControl narrow layout", () => {
  it("stacks and wraps so every control stays reachable below sm", async () => {
    await render(
      <RefreshControl
        refreshInterval={300000}
        onIntervalChange={() => {}}
        onRefreshNow={() => {}}
        lastUpdated="2026-09-17T00:00:00.000Z"
        lastUpdatedLabel="Admin metrics updated"
      />,
    );
    const group = host.firstElementChild as HTMLElement;
    expect(group.classList.contains("flex")).toBe(true);
    expect(group.classList.contains("min-w-0")).toBe(true);
    expect(group.classList.contains("flex-col")).toBe(true);
    expect(group.classList.contains("flex-wrap")).toBe(true);
    expect(group.classList.contains("sm:flex-row")).toBe(true);
    expect(host.textContent).toContain("Admin metrics updated");
    expect(host.textContent).toContain("Refresh Now");
    expect(host.querySelector('[role="combobox"]')).not.toBeNull();
    const interval = [...group.children].find((child) => child.classList.contains("sm:w-28"));
    expect(interval).toBeDefined();
    expect(interval!.classList.contains("w-full")).toBe(true);
    expect(interval!.classList.contains("min-w-0")).toBe(true);
  });
});
