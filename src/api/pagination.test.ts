import { describe, expect, it, vi } from "vitest";
import { collectAllPages } from "./pagination";

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

  it("rejects an invalid caller page size", async () => {
    await expect(collectAllPages(async () => ({
      data: [],
      pagination: { offset: 0, limit: 0, total: 0 },
    }), 0)).rejects.toThrow("positive safe integer");
  });
});
