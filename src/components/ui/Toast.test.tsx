import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./Toast";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Announce({ message }: { message: string }) {
  const { toast } = useToast();
  useEffect(() => toast("error", message), [toast, message]);
  return null;
}

// Several outcomes are reported only by a toast, so it must be announced and
// its dismiss control must say what it does.
describe("ToastProvider", () => {
  it("renders toasts in a polite live region with a labelled dismiss button", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ToastProvider><Announce message="Save failed" /></ToastProvider>));

    const region = host.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toContain("Save failed");
    const dismiss = region?.querySelector("button");
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss notification");
    expect(dismiss?.getAttribute("type")).toBe("button");
  });
});
