import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "@/test/__tests__/harness";
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
