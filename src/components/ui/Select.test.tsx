import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "./Select";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // jsdom has no layout/scroll implementation for Radix's option focus.
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

const options = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
];

function referencedText(element: Element, attribute: string) {
  const ids = element.getAttribute(attribute)?.split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const label = document.getElementById(id);
      expect(label).not.toBeNull();
      return label?.textContent;
    })
    .join(" ");
}

describe("Select accessibility", () => {
  it("names two comboboxes from distinct, stable visible labels", async () => {
    const fields = (error?: string) => (
      <>
        <Select
          label="Backend scheme"
          value="https"
          options={options}
          helpText="Choose the backend transport."
          error={error}
        />
        <Select label="Frontend scheme" value="http" options={options} />
      </>
    );
    await render(fields());
    const triggers = host.querySelectorAll('[role="combobox"]');
    expect(triggers).toHaveLength(2);
    expect(referencedText(triggers[0], "aria-labelledby")).toBe("Backend scheme");
    expect(referencedText(triggers[1], "aria-labelledby")).toBe("Frontend scheme");
    const labelIds = Array.from(triggers, (trigger) =>
      trigger.getAttribute("aria-labelledby"),
    );
    expect(new Set(labelIds).size).toBe(2);
    expect(referencedText(triggers[0], "aria-describedby")).toBe(
      "Choose the backend transport.",
    );
    expect(triggers[1].hasAttribute("aria-describedby")).toBe(false);

    await render(fields("Select a supported transport."));
    expect(
      Array.from(host.querySelectorAll('[role="combobox"]'), (trigger) =>
        trigger.getAttribute("aria-labelledby"),
      ),
    ).toEqual(labelIds);
    expect(referencedText(triggers[0], "aria-describedby")).toBe(
      "Select a supported transport.",
    );
    expect(triggers[0].getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).not.toContain("Choose the backend transport.");

    await render(fields());
    expect(triggers[0].hasAttribute("aria-invalid")).toBe(false);
  });

  it("opens with the keyboard and selects another option", async () => {
    function Field() {
      const [value, setValue] = useState("http");
      return (
        <Select
          label="Backend scheme"
          value={value}
          onValueChange={setValue}
          options={options}
        />
      );
    }
    await render(<Field />);
    const trigger = host.querySelector<HTMLElement>('[role="combobox"]')!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
      // Radix defers focus movement until the keyboard event has completed.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement?.textContent).toBe("HTTPS");
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(trigger.textContent).toBe("HTTPS");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(referencedText(trigger, "aria-labelledby")).toBe("Backend scheme");
  });
});
