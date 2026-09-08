import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Input } from "./Input";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(ui: ReactElement) {
  await act(async () => root.render(ui));
}

function referencedText(element: Element, attribute: string) {
  const ids = element.getAttribute(attribute)?.split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const node = document.getElementById(id);
      expect(node).not.toBeNull();
      return node?.textContent;
    })
    .join(" ");
}

describe("Input accessibility", () => {
  it("associates labels, help text, and errors with distinct ids per instance", async () => {
    const fields = (error?: string) => (
      <>
        <Input
          label="Unhealthy Threshold"
          value="3"
          onChange={() => {}}
          helpText="Failures before marking unhealthy."
          error={error}
        />
        <Input label="Unhealthy Threshold" value="7" onChange={() => {}} />
      </>
    );
    await render(fields());
    const inputs = host.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    const inputIds = Array.from(inputs, (input) => input.id);
    expect(new Set(inputIds).size).toBe(2);
    expect(referencedText(inputs[0], "aria-describedby")).toBe(
      "Failures before marking unhealthy.",
    );
    expect(inputs[1].hasAttribute("aria-describedby")).toBe(false);

    await render(fields("Threshold must be positive."));
    expect(
      Array.from(host.querySelectorAll("input"), (input) => input.id),
    ).toEqual(inputIds);
    expect(referencedText(inputs[0], "aria-describedby")).toBe(
      "Threshold must be positive.",
    );
    expect(inputs[0].getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).not.toContain("Failures before marking unhealthy.");

    await render(fields());
    expect(inputs[0].hasAttribute("aria-invalid")).toBe(false);
  });

  it("honours a caller-supplied id", async () => {
    await render(
      <Input
        id="custom-threshold"
        label="Unhealthy Threshold"
        value="3"
        onChange={() => {}}
        error="Required"
      />,
    );
    const input = host.querySelector("input")!;
    expect(input.id).toBe("custom-threshold");
    expect(host.querySelector('label[for="custom-threshold"]')).not.toBeNull();
    expect(referencedText(input, "aria-describedby")).toBe("Required");
  });
});
