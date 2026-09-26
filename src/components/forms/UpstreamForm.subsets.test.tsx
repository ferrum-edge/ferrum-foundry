import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFormUpdatePayload } from "@/api/upstreams";
import type { SubsetDefinition, Upstream, UpstreamCreate } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { click, createHarness, fill } from "@/test/__tests__/harness";
import { UpstreamForm } from "./UpstreamForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
let ui: ReturnType<typeof createHarness>;
const submit = vi.fn<(data: UpstreamCreate) => Promise<void>>();

function upstream(subsets: SubsetDefinition[]): Upstream {
  return {
    id: "orders", name: "Orders", algorithm: "round_robin",
    targets: [{ host: "backend", port: 8080, weight: 1, tags: { release: "blue,green" } }],
    subsets,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
}

beforeEach(() => {
  ui = createHarness();
  submit.mockReset();
  submit.mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  await ui.dispose();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(data: Upstream) {
  await ui.render(<UpstreamForm initialData={data} onSubmit={submit} isLoading={false} />);
}

async function save() {
  await act(async () => {
    ui.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function openSubsets() {
  const toggle = [...ui.host.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.includes("Subsets"))!;
  await act(async () => toggle.click());
}

function subsetGroup(name: string): HTMLElement {
  const group = ui.host.querySelector<HTMLElement>(`[role="group"][aria-label="Subset ${name}"]`);
  expect(group, `subset ${name}`).not.toBeNull();
  return group!;
}

function labelInput(subset: string, row: number, part: "key" | "value"): HTMLInputElement {
  const input = ui.host.querySelector<HTMLInputElement>(
    `input[aria-label="Subset ${subset} label ${row} ${part}"]`,
  );
  expect(input, `subset ${subset} label ${row} ${part}`).not.toBeNull();
  return input!;
}

/** What the Settings route sends: the form's change set merged over the read. */
function outgoingSubsets(data: Upstream, call = 0) {
  return mergeFormUpdatePayload(data, submit.mock.calls[call][0]).subsets;
}

describe("subset selectors through the upstream form (#479)", () => {
  const delimiterSelectors: [string, Record<string, string>][] = [
    ["a comma in a value", { release: "blue,green" }],
    ["an equals sign in a key", { "release=channel": "blue" }],
    ["surrounding whitespace", { " release ": " blue " }],
    ["delimiters on both sides", { "a=b,c": "d=e, f", tier: "" }],
  ];

  it.each(delimiterSelectors)("keeps a selector with %s through an unrelated save", async (_label, labels) => {
    const data = upstream([{ name: "selected", labels }]);
    await mount(data);
    await fill(inputByLabel(ui.host, "Name"), "Orders v2");
    await save();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].name).toBe("Orders v2");
    const sent = outgoingSubsets(data);
    expect(sent).toEqual([{ name: "selected", labels }]);
    expect(JSON.stringify(sent?.[0].labels)).toBe(JSON.stringify(labels));
  });

  it("shows each fetched label as its own exact key and value", async () => {
    await mount(upstream([{ name: "selected", labels: { "release=channel": "blue,green", tier: "gold" } }]));
    await openSubsets();
    expect(labelInput("selected", 1, "key").value).toBe("release=channel");
    expect(labelInput("selected", 1, "value").value).toBe("blue,green");
    expect(labelInput("selected", 2, "key").value).toBe("tier");
    expect(labelInput("selected", 2, "value").value).toBe("gold");
  });

  it("keeps ordinary multi-label selectors and every other subset unchanged", async () => {
    const subsets: SubsetDefinition[] = [
      { name: "v1", labels: { version: "v1", tier: "stable" }, traffic_policy: { hash_on: "ip" } },
      { name: "v2", labels: { version: "v2", tier: "canary" } },
    ];
    const data = upstream(subsets);
    await mount(data);
    await save();
    expect(outgoingSubsets(data)).toEqual(subsets);
  });

  it("writes an edited selector exactly as entered, delimiters included", async () => {
    const data = upstream([
      { name: "selected", labels: { release: "blue" } },
      { name: "other", labels: { "keep=me": "x,y" } },
    ]);
    await mount(data);
    await openSubsets();
    await fill(labelInput("selected", 1, "value"), "blue,green");
    await click("Add label to subset selected", subsetGroup("selected"));
    await fill(labelInput("selected", 2, "key"), "zone=a");
    await fill(labelInput("selected", 2, "value"), " east ");
    await save();
    expect(outgoingSubsets(data)).toEqual([
      { name: "selected", labels: { release: "blue,green", "zone=a": " east " } },
      { name: "other", labels: { "keep=me": "x,y" } },
    ]);
  });

  it("removes a single label and a whole subset explicitly", async () => {
    const data = upstream([
      { name: "a", labels: { version: "v1", tier: "gold" } },
      { name: "b", labels: { version: "v2" } },
    ]);
    await mount(data);
    await openSubsets();
    await click("Remove label tier from subset a", subsetGroup("a"));
    await click("Remove subset b", ui.host);
    await save();
    expect(outgoingSubsets(data)).toEqual([{ name: "a", labels: { version: "v1" } }]);

    await click("Remove subset a", ui.host);
    await save();
    // No subsets left: the field is omitted and the merge clears it.
    expect(submit.mock.calls[1][0]).not.toHaveProperty("subsets");
    expect(outgoingSubsets(data, 1)).toBeNull();
  });

  it("refuses malformed edited labels visibly instead of dropping them", async () => {
    const data = upstream([{ name: "selected", labels: { version: "v1" } }]);
    await mount(data);
    await openSubsets();
    const group = subsetGroup("selected");

    await click("Add label to subset selected", group);
    await fill(labelInput("selected", 2, "value"), "orphan");
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(labelInput("selected", 2, "key").getAttribute("aria-invalid")).toBe("true");
    expect(group.textContent).toContain("Label key is required");

    await fill(labelInput("selected", 2, "key"), "version");
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(group.textContent).toContain('Duplicate label key "version"');

    await click("Remove label version from subset selected", group);
    await click("Remove label version from subset selected", group);
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(group.textContent).toContain("A subset must select at least one label");

    await click("Add label to subset selected", group);
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(group.textContent).toContain("Enter a label or remove this row");

    await fill(labelInput("selected", 1, "key"), "tier");
    await fill(labelInput("selected", 1, "value"), "a,b");
    await save();
    expect(submit).toHaveBeenCalledOnce();
    expect(outgoingSubsets(data)).toEqual([{ name: "selected", labels: { tier: "a,b" } }]);
  });

  it("creates a subset from key/value rows", async () => {
    const data = upstream([]);
    await mount(data);
    await openSubsets();
    await click("Add Subset", ui.host);
    const group = subsetGroup("1");
    await fill(inputByLabel(group, "Subset Name"), "selected");
    await fill(labelInput("selected", 1, "key"), "release");
    await fill(labelInput("selected", 1, "value"), "blue,green");
    await save();
    expect(outgoingSubsets(data)).toEqual([{ name: "selected", labels: { release: "blue,green" } }]);
  });
});
