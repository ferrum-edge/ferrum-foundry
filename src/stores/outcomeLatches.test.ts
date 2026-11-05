import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOutcomeLatches,
  correlationId,
  latchKeys,
  latchOutcome,
  releaseOutcomeLatch,
  settleOutcomeLatches,
  getOutcomeLatches,
  settledBy,
} from "./outcomeLatches";
import type { AcmeOrder } from "@/api/tls";

afterEach(() => {
  vi.unstubAllGlobals();
  clearOutcomeLatches();
});

describe("correlationId", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

    releaseOutcomeLatch(latchKeys.apiSpecWrite("tenant-b"));
    expect(getOutcomeLatches().has(key)).toBe(true);
    releaseOutcomeLatch(key);
    expect(getOutcomeLatches().has(key)).toBe(false);
  });
});
