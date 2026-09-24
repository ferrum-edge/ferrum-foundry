import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputByLabel } from "@/test/fields";
import { CollapsibleSection } from "./CollapsibleSection";
import { TagInput } from "./TagInput";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let current: (string | number)[];

function Harness({ initial, parseAsNumber = false }: { initial: (string | number)[]; parseAsNumber?: boolean }) {
  const [values, setValues] = useState(initial);
  current = values;
  return <TagInput label="Hosts" values={values} onChange={setValues} parseAsNumber={parseAsNumber} helpText="One per entry" />;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

describe("TagInput", () => {
  it("labels its field and names each remove button", async () => {
    await act(async () => root.render(<Harness initial={["api.example.com"]} />));
    const field = inputByLabel(host, "Hosts");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Remove api.example.com"]');
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(current).toEqual([]);
  });

  it("adds comma-separated entries once, parsing numbers when asked", async () => {
    await act(async () => root.render(<Harness initial={[500]} parseAsNumber />));
    await type(inputByLabel(host, "Hosts"), "502, 500, nope, 503");
    expect(current).toEqual([500, 502, 503]);
  });
});

describe("CollapsibleSection", () => {
  it("exposes its expanded state on the toggle", async () => {
    await act(async () => root.render(<CollapsibleSection title="Timeouts"><p>body</p></CollapsibleSection>));
    const toggle = host.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toBe("body");
  });
});
