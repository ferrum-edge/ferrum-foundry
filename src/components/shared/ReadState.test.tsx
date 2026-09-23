/* ------------------------------------------------------------------ */
/*  A refused read is a denial, not missing data (issue #385).         */
/*  Only 404/503 on an optional surface mean "not enabled here"; a     */
/*  403 is an answer about the session's role or namespace grant.      */
/* ------------------------------------------------------------------ */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadQuery } from "@/lib/readState";
import { isReadDenied, ReadStateNotice } from "./ReadState";

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

function failed(status: number, data?: unknown): ReadQuery {
  return {
    data,
    isError: true,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: data === undefined ? 0 : Date.parse("2026-09-01T00:00:00Z"),
    error: { response: { status } },
    refetch: vi.fn(async () => undefined),
  };
}

describe("isReadDenied", () => {
  it("is true only for a 403", () => {
    expect(isReadDenied({ response: { status: 403 } })).toBe(true);
    for (const status of [401, 404, 500, 503]) {
      expect(isReadDenied({ response: { status } })).toBe(false);
    }
    expect(isReadDenied(null)).toBe(false);
    expect(isReadDenied(new Error("network"))).toBe(false);
  });
});

describe("ReadStateNotice", () => {
  it("names a 403 as an authorization denial, never as a missing feature", async () => {
    await render(<ReadStateNotice query={failed(403)} label="Audit log" optionalFeature />);

    const notice = host.querySelector("[data-read-denied]");
    expect(notice).not.toBeNull();
    expect(host.textContent).toContain("Audit log: read not permitted for this session");
    expect(host.textContent).toContain("not missing or empty data");
    expect(host.textContent).not.toContain("may not be enabled in this mode");
    expect(host.textContent).not.toContain("Audit log unavailable");
  });

  it("keeps the feature-miss explanation for 404 and 503 on an optional surface", async () => {
    for (const status of [404, 503]) {
      await render(<ReadStateNotice query={failed(status)} label="Audit log" optionalFeature />);
      expect(host.querySelector("[data-read-denied]")).toBeNull();
      expect(host.textContent).toContain("Audit log unavailable");
      expect(host.textContent).toContain("may not be enabled in this mode");
    }
  });

  it("reports a refresh denied after a successful read as stale, keeping the observation", async () => {
    await render(<ReadStateNotice query={failed(403, [])} label="Audit log" />);
    expect(host.querySelector("[data-read-denied]")).toBeNull();
    expect(host.textContent).toContain("Audit log could not refresh");
  });
});
