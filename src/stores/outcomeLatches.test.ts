import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginWrite,
  clearOutcomeLatches,
  isWriteInFlight,
  correlationId,
  latchKeys,
  latchOutcome,
  releaseOutcomeLatch,
  settleOutcomeLatches,
  getOutcomeLatches,
  settledBy,
} from "./outcomeLatches";
import type { AcmeOrder } from "@/api/tls";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  clearOutcomeLatches();
});

describe("correlationId", () => {
  it("falls back to getRandomValues outside a secure context", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });
    expect(correlationId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(correlationId()).toMatch(UUID_V4);
  });

  it("fails before anything is sent when the browser has no Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => correlationId()).toThrow();
  });
});

describe("api_spec_write latch", () => {
  const latch = { kind: "api_spec_write" as const, namespace: "tenant-a", message: "unknown" };
  const order: AcmeOrder = {
    id: "o-1", domains: ["example.test"], directory_url: "https://ca.example.test/directory",
    status: "valid", created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  };

  it("never settles from a read; only a deliberate release ends it", () => {
    expect(settledBy(latch, {})).toBe(false);
    expect(settledBy(latch, { acmeOrders: [order] })).toBe(false);

    const key = latchKeys.apiSpecWrite("tenant-a");
    latchOutcome(latch);
    latchOutcome({ kind: "acme_finalization", orderId: "o-1" });
    settleOutcomeLatches({ acmeOrders: [order] });
    // The terminal order settles its finalization; nothing settles the spec write.
    expect(getOutcomeLatches().has(latchKeys.acmeFinalization("o-1"))).toBe(false);
    expect(getOutcomeLatches().get(key)).toEqual(latch);

    const reviewed = getOutcomeLatches().get(key)!;
    expect(releaseOutcomeLatch(latchKeys.apiSpecWrite("tenant-b"), reviewed)).toBe(false);
    expect(getOutcomeLatches().has(key)).toBe(true);

    // A newer unanswered write replaced the one the operator reviewed.
    latchOutcome({ ...latch, message: "newer" });
    expect(releaseOutcomeLatch(key, reviewed)).toBe(false);
    expect(getOutcomeLatches().get(key)).toMatchObject({ message: "newer" });
    expect(releaseOutcomeLatch(key, getOutcomeLatches().get(key)!)).toBe(true);
    expect(getOutcomeLatches().has(key)).toBe(false);
  });
});

describe("writes in flight", () => {
  it("count every dispatched write for a key until each is released once", () => {
    const key = latchKeys.apiSpecWrite("tenant-a");
    const first = beginWrite(key);
    const second = beginWrite(key);
    first();
    first();
    expect(isWriteInFlight(key)).toBe(true);
    expect(isWriteInFlight(latchKeys.apiSpecWrite("tenant-b"))).toBe(false);
    second();
    expect(isWriteInFlight(key)).toBe(false);
  });
});
