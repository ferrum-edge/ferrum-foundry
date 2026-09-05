import { describe, expect, it } from "vitest";
import { parseSearchWith } from "@tanstack/react-router";
import {
  DEFAULT_PAGE_SIZE,
  MAX_OFFSET,
  sanitizePaginationSearch,
} from "./usePagination";

describe("sanitizePaginationSearch", () => {
  it.each([
    [{ offset: "0", limit: "20" }, { offset: 0, limit: 20, changed: false }],
    [{ offset: "40", limit: "50" }, { offset: 40, limit: 50, changed: false }],
    [{ offset: "-1", limit: "20" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: -20, limit: 20 }, { offset: 0, limit: 20, changed: true }],
    [
      { offset: MAX_OFFSET, limit: 20 },
      { offset: MAX_OFFSET, limit: 20, changed: false },
    ],
    [{ offset: MAX_OFFSET + 1, limit: 20 }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "1.5", limit: "20" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "NaN", limit: "20" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "0", limit: "0" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "0", limit: "-20" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "0", limit: "1.5" }, { offset: 0, limit: 20, changed: true }],
    [{ offset: "0", limit: "999999" }, { offset: 0, limit: 20, changed: true }],
    [
      { offset: String(MAX_OFFSET + 1), limit: "20" },
      { offset: 0, limit: 20, changed: true },
    ],
  ])("sanitizes %j", (input, expected) => {
    expect(sanitizePaginationSearch(input)).toEqual(expected);
  });

  it("accepts a supported custom default and rejects an unsupported one", () => {
    expect(sanitizePaginationSearch({}, 50).limit).toBe(50);
    expect(sanitizePaginationSearch({}, 7).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it("corrects a numeric negative offset from the real router parser", () => {
    const search = parseSearchWith(JSON.parse)("?offset=-20&limit=20");
    expect(search.offset).toBe(-20);
    expect(sanitizePaginationSearch(search)).toEqual({
      offset: 0,
      limit: 20,
      changed: true,
    });
  });
});
