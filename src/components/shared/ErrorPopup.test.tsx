import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, createHarness, settle } from "@/test/__tests__/harness";
import { ErrorPopup } from "./ErrorPopup";

let ui: ReturnType<typeof createHarness>;

beforeEach(() => {
  ui = createHarness();
});
afterEach(async () => {
  await ui.dispose();
});

function titleRow() {
  const title = document.querySelector<HTMLElement>('[role="dialog"] h2');
  expect(title).not.toBeNull();
  return title!.parentElement!.textContent;
}

describe("ErrorPopup status badge", () => {
  it("shows the HTTP status when the gateway answered", async () => {
    await ui.render(<ErrorPopup open onClose={() => undefined} statusCode={503} />);
    expect(titleRow()).toBe("API Error503");
  });

  it("shows no badge, and no stray 0, when no HTTP answer arrived", async () => {
    await ui.render(
      <ErrorPopup
        open
        onClose={() => undefined}
        statusCode={0}
        outcome={{ reason: "transport", detail: null }}
      />,
    );
    expect(titleRow()).toBe("Outcome unknown");
  });
});

describe("ErrorPopup copy", () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  function copyStatus() {
    return document.querySelector('[role="dialog"] [role="status"]')?.textContent;
  }

  it("reports a copy", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await ui.render(<ErrorPopup open onClose={() => undefined} statusCode={503} url="/api/proxy/x" />);
    await click("Copy Error");
    await settle(() => expect(copyStatus()).toBe("Error details copied."));
    expect(writeText).toHaveBeenCalledWith("Status: 503\nURL: /api/proxy/x");
  });

  it("tells the operator to copy manually when the clipboard refuses", async () => {
    const writeText = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await ui.render(<ErrorPopup open onClose={() => undefined} statusCode={503} />);
    await click("Copy Error");
    await settle(() => expect(copyStatus()).toContain("copy them manually"));
  });
});
