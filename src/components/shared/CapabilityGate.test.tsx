/* ------------------------------------------------------------------ */
/*  Direct coverage for CapabilityGate presentation (issue #373).      */
/*  Transitive route tests do not assert aria-describedby injection,   */
/*  WriteAction's disabled prop, or the fieldset min-w-0 / contents    */
/*  class branches.                                                    */
/* ------------------------------------------------------------------ */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityVerdict } from "@/lib/capabilities";
import { ReadOnlySurface, WriteAction } from "./CapabilityGate";

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

const denied: CapabilityVerdict = {
  allowed: false,
  label: "Proxy configuration",
  headline: "Proxy configuration is read-only",
  blockedBy: "role",
  summary: "Requires the operator role",
  explanation: "Your session has the viewer role, which cannot create, edit, or delete proxies.",
};

const allowed: CapabilityVerdict = {
  allowed: true,
  label: "Proxy configuration",
  headline: "Proxy configuration is read-only",
};

describe("WriteAction", () => {
  it("injects aria-describedby and disabled on the child when denied", async () => {
    await render(
      <WriteAction verdict={denied}>
        <button type="button">Create Proxy</button>
      </WriteAction>,
    );

    const button = host.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector("fieldset")).toBeNull();

    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId!);
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain("Requires the operator role");
    expect(reason?.textContent).toContain("viewer role");
    expect(reason?.getAttribute("data-capability-blocked")).toBe("role");
  });

  it("renders the child untouched when allowed", async () => {
    await render(
      <WriteAction verdict={allowed}>
        <button type="button">Create Proxy</button>
      </WriteAction>,
    );

    const button = host.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(host.querySelector("fieldset")).toBeNull();
    expect(host.querySelector("[data-capability-blocked]")).toBeNull();
    expect(host.textContent).toBe("Create Proxy");
  });
});

describe("ReadOnlySurface", () => {
  it("defaults the denied fieldset to display contents without min-w-0", async () => {
    await render(
      <ReadOnlySurface verdict={denied}>
        <input aria-label="Name" />
      </ReadOnlySurface>,
    );

    const fieldset = host.querySelector("fieldset")!;
    expect(fieldset.disabled).toBe(true);
    expect(fieldset.className).toBe("contents");
    expect(fieldset.className).not.toContain("min-w-0");
    expect(fieldset.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("adds min-w-0 when contentClassName makes the fieldset a real box", async () => {
    await render(
      <ReadOnlySurface verdict={denied} contentClassName="space-y-4">
        <input aria-label="Name" />
      </ReadOnlySurface>,
    );

    const fieldset = host.querySelector("fieldset")!;
    expect(fieldset.disabled).toBe(true);
    expect(fieldset.className).toContain("min-w-0");
    expect(fieldset.className).toContain("space-y-4");
    expect(fieldset.className.split(/\s+/)).not.toContain("contents");
  });

  it("renders children without a fieldset when allowed", async () => {
    await render(
      <ReadOnlySurface verdict={allowed} contentClassName="space-y-4">
        <input aria-label="Name" />
      </ReadOnlySurface>,
    );

    expect(host.querySelector("fieldset")).toBeNull();
    expect(host.querySelector("input")).not.toBeNull();
  });
});
