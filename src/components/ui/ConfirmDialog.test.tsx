import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "@/test/__tests__/harness";
import { ConfirmDialog } from "./ConfirmDialog";

let ui: ReturnType<typeof createHarness>;
const onOpenChange = vi.fn<(open: boolean) => void>();

beforeEach(() => {
  ui = createHarness();
  onOpenChange.mockReset();
});
afterEach(async () => {
  await ui.dispose();
});

async function mount(props: { loading: boolean; busy?: boolean }) {
  await ui.render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete credential?"
      onConfirm={() => undefined}
      {...props}
    />,
  );
}

async function tryToClose() {
  const content = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click();
  });
  await act(async () => {
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("ConfirmDialog busy state", () => {
  it("refuses every way out while its own request runs", async () => {
    await mount({ loading: true });
    await tryToClose();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still closes while it only shows loading for something else, such as a refetch", async () => {
    await mount({ loading: true, busy: false });
    await tryToClose();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
