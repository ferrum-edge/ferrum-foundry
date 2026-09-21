import { describe, expect, it, vi } from "vitest";
import { collectAllPages, collectBoundedPages } from "./pagination";

describe("collectAllPages", () => {
  it("walks every page using the number of returned records", async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({
      data: Array.from(
        { length: Math.min(limit, 5 - offset) },
        (_, index) => offset + index,
      ),
      pagination: { offset, limit, total: 5 },
    }));

    await expect(collectAllPages(fetchPage, 2)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("rejects a page that stops advancing before total", async () => {
    await expect(collectAllPages(async (offset) => ({
      data: [],
      pagination: { offset, limit: 10, total: 1 },
    }))).rejects.toThrow("stopped advancing");
  });

  it("rejects inconsistent offsets", async () => {
    await expect(collectAllPages(async () => ({
      data: [1],
      pagination: { offset: 4, limit: 10, total: 1 },
    }))).rejects.toThrow("inconsistent pagination");
  });

  it("rejects a total that changes between pages", async () => {
    await expect(
      collectAllPages(
        async (offset) => ({
          data: [offset],
          pagination: { offset, limit: 1, total: offset === 0 ? 2 : 3 },
        }),
        1,
      ),
    ).rejects.toThrow("changed pagination total");
  });

  it("rejects an invalid caller page size", async () => {
    await expect(collectAllPages(async () => ({
      data: [],
      pagination: { offset: 0, limit: 0, total: 0 },
    }), 0)).rejects.toThrow("positive safe integer");
  });
});

describe("collectBoundedPages", () => {
  const gateway = (total: number) =>
    vi.fn(async (offset: number, limit: number) => ({
      data: Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, index) => offset + index,
      ),
      pagination: { offset, limit, total },
    }));

  it("reports a whole collection as complete", async () => {
    const fetchPage = gateway(5);
    await expect(collectBoundedPages(fetchPage, { pageSize: 2, budget: 100 })).resolves.toEqual({
      items: [0, 1, 2, 3, 4],
      total: 5,
      complete: true,
    });
  });

  it("stops at the budget and says the traversal is incomplete", async () => {
    const fetchPage = gateway(1_000);
    const collected = await collectBoundedPages(fetchPage, { pageSize: 100, budget: 250 });

    expect(collected.complete).toBe(false);
    expect(collected.total).toBe(1_000);
    expect(collected.items).toHaveLength(300);
    // Three pages, then it stops. Not ten.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("never reports a partial traversal as complete", async () => {
    const collected = await collectBoundedPages(gateway(10), { pageSize: 4, budget: 4 });
    expect(collected.items.length).toBeLessThan(collected.total);
    expect(collected.complete).toBe(false);
  });

  it("abandons the remaining pages when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async (offset: number, limit: number) => {
      if (offset > 0) controller.abort();
      return {
        data: Array.from({ length: limit }, (_, index) => offset + index),
        pagination: { offset, limit, total: 1_000 },
      };
    });

    await expect(
      collectBoundedPages(fetchPage, { pageSize: 10, signal: controller.signal }),
    ).rejects.toThrow();
    // The page that aborted, and nothing after it.
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("passes the signal down so an in-flight page can be cancelled too", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await collectBoundedPages(
      async (offset, limit, signal) => {
        seen.push(signal);
        return { data: [offset], pagination: { offset, limit, total: 1 } };
      },
      { pageSize: 1, signal: controller.signal },
    );
    expect(seen).toEqual([controller.signal]);
  });

  it("rejects a budget that is not a positive integer", async () => {
    await expect(
      collectBoundedPages(gateway(1), { budget: 0 }),
    ).rejects.toThrow("positive safe integer");
  });

  it("still refuses to mix a changed collection total", async () => {
    await expect(
      collectBoundedPages(
        async (offset, limit) => ({
          data: [offset],
          pagination: { offset, limit, total: offset === 0 ? 5 : 6 },
        }),
        { pageSize: 1, budget: 100 },
      ),
    ).rejects.toThrow("changed pagination total");
  });
});

describe("collectAllPages", () => {
  it("is completeness on top of the bounded walk", async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({
      data: Array.from({ length: Math.min(limit, 7 - offset) }, (_, i) => offset + i),
      pagination: { offset, limit, total: 7 },
    }));
    await expect(collectAllPages(fetchPage, 3)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
