import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamCreate, UpstreamTarget } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { click, createHarness, fill } from "@/test/__tests__/harness";
import { TargetForm } from "./TargetForm";

let ui: ReturnType<typeof createHarness>;
const submit = vi.fn<(target: UpstreamTarget) => void>();
const cancel = vi.fn();
const parentSubmit = vi.fn();
const parentKeyDown = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  ui = createHarness();
});
afterEach(async () => ui.dispose());

async function mount(initialData?: UpstreamTarget) {
  await ui.render(
    <form onSubmit={parentSubmit} onKeyDown={parentKeyDown}>
      <TargetForm initialData={initialData} onSubmit={submit} onCancel={cancel} />
    </form>,
  );
}

async function key(input: HTMLInputElement, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => { input.dispatchEvent(event); });
  return event;
}

describe("TargetForm inline editor", () => {
  it.each(["", "0", "-1", "65536"])("rejects blank hosts, invalid port %j, and negative weights", async (port) => {
    await mount();
    await fill(inputByLabel(ui.host, "Host"), "   ");
    await fill(inputByLabel(ui.host, "Port"), port);
    await fill(inputByLabel(ui.host, "Weight"), "-1");
    await click("Add Target");
    expect(submit).not.toHaveBeenCalled();
    expect(ui.host.textContent).toContain("Host is required");
    expect(ui.host.textContent).toContain("Valid port required (1-65535)");
    expect(ui.host.textContent).toContain("Weight must be >= 0");
    await fill(inputByLabel(ui.host, "Host"), " backend.example.test ");
    await fill(inputByLabel(ui.host, "Port"), "65535");
    await fill(inputByLabel(ui.host, "Weight"), "0");
    await click("Add Target");
    const expected: UpstreamCreate["targets"][number] = {
      host: "backend.example.test", port: 65535, weight: 0, path: null, locality: null, tags: {},
    };
    expect(submit).toHaveBeenCalledExactlyOnceWith(expected);
    expect(ui.host.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(ui.host.querySelectorAll("form")).toHaveLength(1);
  });

  it("submits trimmed path and locality on Enter without submitting the upstream", async () => {
    await mount();
    await fill(inputByLabel(ui.host, "Host"), " backend ");
    await fill(inputByLabel(ui.host, "Path"), " /v2 ");
    await fill(inputByLabel(ui.host, "Locality"), " us/east/zone-a ");
    const event = await key(inputByLabel(ui.host, "Host"), "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      host: "backend", port: 80, weight: 1, path: "/v2", locality: "us/east/zone-a", tags: {},
    });
  });

  it("edits tags with Enter, comma and blur, rejects malformed pairs, and removes tags", async () => {
    const initial: UpstreamTarget = {
      host: "backend", port: 443, weight: 5, path: "/old", locality: "us/east",
      tags: { version: "v1" },
    };
    await mount(initial);
    const input = ui.host.querySelector<HTMLInputElement>('input:not([id])')!;
    for (const raw of ["broken", ":value", "key:", " : value"]) {
      await fill(input, raw);
      await key(input, "Enter");
      expect(input.value).toBe("");
    }
    await fill(input, " version: v2 ");
    await key(input, ",");
    await fill(input, "url: https://backend.example.test");
    await key(input, "Enter");
    await fill(input, "team: payments");
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(ui.host.textContent).toContain("team:payments");
    const tag = [...ui.host.querySelectorAll("span")].find((entry) =>
      entry.textContent === "version:v2" && entry.querySelector("button"),
    )!;
    await act(async () => tag.querySelector("button")!.click());
    await fill(inputByLabel(ui.host, "Path"), " ");
    await fill(inputByLabel(ui.host, "Locality"), " ");
    expect(submit).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
    await click("Update Target");
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      host: "backend", port: 443, weight: 5, path: null, locality: null,
      tags: { url: "https://backend.example.test", team: "payments" },
    });
    expect(initial.tags).toEqual({ version: "v1" });
  });

  it("cancels without submitting and lets unrelated keys propagate", async () => {
    await mount();
    const event = await key(inputByLabel(ui.host, "Host"), "Escape");
    expect(event.defaultPrevented).toBe(false);
    expect(parentKeyDown).toHaveBeenCalledOnce();
    await click("Cancel");
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
  });
});
